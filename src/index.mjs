import 'dotenv/config'
import process from 'node:process'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import {
  createNotificationServer,
  formatBalanceMessage,
  formatRatioMessage,
  isAllowedGroupCommand,
  isAllowedQueryCommand,
  normalizeGroupId,
} from './notification-api.mjs'

const monitorUrl = 'https://status.yyapi.cloud/status/ai-status'
const statusPageMessage = '云影公开渠道状态页：https://status.yyapi.cloud/status/ai-status'
const onebotUrl = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001'
const command = process.env.COMMAND || '查监控'
const balanceCommand = process.env.BALANCE_COMMAND || '查余额'
const balanceApiUrl = process.env.BALANCE_API_URL || 'http://upstream-ratio-watch:8000/api/bot/balances'
const ratioCommand = process.env.RATIO_COMMAND || '查倍率'
const ratioApiUrl = process.env.RATIO_API_URL || 'http://upstream-ratio-watch:8000/api/bot/ratios'
const queryGroupId = normalizeGroupId(process.env.QUERY_GROUP_ID)
const notificationGroupId = normalizeGroupId(process.env.NOTIFY_GROUP_ID)
const notifyApiToken = String(process.env.NOTIFY_API_TOKEN || '').trim()
const notifyHost = process.env.NOTIFY_HOST || '0.0.0.0'
const notifyPort = Number(process.env.NOTIFY_PORT || 3100)
const delayMs = Number(process.env.SCREENSHOT_DELAY_MS || 3000)
const viewport = {
  width: Number(process.env.VIEWPORT_WIDTH || 1440),
  height: Number(process.env.VIEWPORT_HEIGHT || 900),
}

const browser = await chromium.launch({ headless: true })
const seenMessages = new Set()
let queue = Promise.resolve()
let ws
let reconnectTimer
let stopping = false
let echoSequence = 0
const pendingActions = new Map()

const rememberMessage = (event) => {
  if (event.message_id === null || event.message_id === undefined) return true
  if (seenMessages.has(event.message_id)) return false
  seenMessages.add(event.message_id)
  if (seenMessages.size > 1000) seenMessages.delete(seenMessages.values().next().value)
  return true
}

const sendGroupMessage = (groupId, message) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('OneBot WebSocket 未连接')
  const normalizedGroupId = normalizeGroupId(groupId)
  if (!normalizedGroupId) throw new Error('QQ群号格式无效')

  const echo = `send-group-${Date.now()}-${echoSequence += 1}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingActions.delete(echo)
      reject(new Error('OneBot 发送响应超时'))
    }, 15000)

    pendingActions.set(echo, { resolve, reject, timeout })
    ws.send(JSON.stringify({
      action: 'send_group_msg',
      params: {
        group_id: Number(normalizedGroupId),
        message,
      },
      echo,
    }), (error) => {
      if (!error) return
      clearTimeout(timeout)
      pendingActions.delete(echo)
      reject(error)
    })
  })
}

const settleOneBotAction = (payload) => {
  if (!payload?.echo || !pendingActions.has(payload.echo)) return false
  const pending = pendingActions.get(payload.echo)
  pendingActions.delete(payload.echo)
  clearTimeout(pending.timeout)
  if (payload.status === 'ok' && Number(payload.retcode || 0) === 0) {
    pending.resolve(payload.data || {})
  } else {
    pending.reject(new Error(payload.message || payload.wording || `OneBot retcode=${payload.retcode}`))
  }
  return true
}

const rejectPendingActions = (message) => {
  for (const pending of pendingActions.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error(message))
  }
  pendingActions.clear()
}

const capture = async () => {
  const page = await browser.newPage({
    viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  })

  try {
    await page.goto(monitorUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(delayMs)
    return await page.screenshot({
      fullPage: process.env.SCREENSHOT_FULL_PAGE === 'true',
      type: 'png',
    })
  } finally {
    await page.close()
  }
}

const fetchMonitorData = async (url, { method = 'GET', timeoutMs = 15000 } = {}) => {
  if (!notifyApiToken) throw new Error('NOTIFY_API_TOKEN 未配置')
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${notifyApiToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`监控接口返回无效响应（HTTP ${response.status}）`)
  }
  if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
    throw new Error(payload?.message || `监控接口请求失败（HTTP ${response.status}）`)
  }
  return payload.data
}

const fetchBalances = () => fetchMonitorData(balanceApiUrl)

const fetchRatios = () => fetchMonitorData(ratioApiUrl, { method: 'POST', timeoutMs: 120000 })

const handleMessage = (event) => {
  if (isAllowedGroupCommand(event, notificationGroupId, ratioCommand)) {
    if (!rememberMessage(event)) return
    queue = queue
      .then(async () => {
        console.log(`收到群 ${event.group_id} 的实时倍率请求`)
        const sites = await fetchRatios()
        await sendGroupMessage(notificationGroupId, formatRatioMessage(sites))
      })
      .catch((error) => {
        console.error('倍率查询或发送失败:', error)
        Promise.resolve()
          .then(() => sendGroupMessage(notificationGroupId, `倍率查询失败：${error.message}`))
          .catch((sendError) => console.error('发送倍率查询失败提示时出错:', sendError))
      })
    return
  }

  if (isAllowedGroupCommand(event, notificationGroupId, balanceCommand)) {
    if (!rememberMessage(event)) return
    queue = queue
      .then(async () => {
        console.log(`收到群 ${event.group_id} 的余额请求`)
        const sites = await fetchBalances()
        await sendGroupMessage(notificationGroupId, formatBalanceMessage(sites))
      })
      .catch((error) => {
        console.error('余额查询或发送失败:', error)
        Promise.resolve()
          .then(() => sendGroupMessage(notificationGroupId, `余额查询失败：${error.message}`))
          .catch((sendError) => console.error('发送余额查询失败提示时出错:', sendError))
      })
    return
  }

  if (!isAllowedQueryCommand(event, queryGroupId, command)) return
  if (!rememberMessage(event)) return

  queue = queue
    .then(async () => {
      console.log(`收到群 ${event.group_id} 的截图请求`)
      const image = await capture()
      await sendGroupMessage(queryGroupId, statusPageMessage)
      await sendGroupMessage(queryGroupId, [{
        type: 'image',
        data: {
          file: `base64://${image.toString('base64')}`,
        },
      }])
    })
    .catch((err) => {
      console.error('截图或发送失败:', err)
      Promise.resolve()
        .then(() => sendGroupMessage(queryGroupId, '截图失败，请稍后重试'))
        .catch((sendErr) => {
          console.error('发送失败提示时出错:', sendErr)
        })
    })
}

const connect = () => {
  const headers = process.env.ONEBOT_ACCESS_TOKEN
    ? { Authorization: `Bearer ${process.env.ONEBOT_ACCESS_TOKEN}` }
    : undefined

  ws = new WebSocket(onebotUrl, { headers })

  ws.on('open', () => {
    console.log(`已连接 OneBot: ${onebotUrl}`)
  })

  ws.on('message', (data) => {
    try {
      const payload = JSON.parse(data.toString())
      if (!settleOneBotAction(payload)) handleMessage(payload)
    } catch (err) {
      console.warn('忽略无法解析的 OneBot 消息:', err.message)
    }
  })

  ws.on('error', (err) => {
    console.error('OneBot WebSocket 错误:', err.message)
  })

  ws.on('close', () => {
    rejectPendingActions('OneBot WebSocket 已断开')
    if (stopping) return
    console.warn('OneBot 连接已断开，5 秒后重连')
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 5000)
  })
}

if (!queryGroupId) {
  console.warn('QUERY_GROUP_ID 未配置，“查监控”指令已禁用')
}

const notificationServer = createNotificationServer({
  apiToken: notifyApiToken,
  notificationGroupId,
  isOneBotConnected: () => ws?.readyState === WebSocket.OPEN,
  sendGroupMessage,
})

notificationServer.listen(notifyPort, notifyHost, () => {
  console.log(`通知接口监听 http://${notifyHost}:${notifyPort}`)
  if (!notifyApiToken) console.warn('NOTIFY_API_TOKEN 未配置，通知接口将拒绝所有请求')
  if (!notificationGroupId) console.warn('NOTIFY_GROUP_ID 未配置，QQ通知已禁用')
  console.log(`余额查询接口: ${balanceApiUrl}`)
  console.log(`实时倍率接口: ${ratioApiUrl}`)
})

const shutdown = async () => {
  stopping = true
  clearTimeout(reconnectTimer)
  ws?.close()
  rejectPendingActions('机器人正在停止')
  await new Promise((resolve) => notificationServer.close(resolve))
  await queue.catch(() => {})
  await browser.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

connect()
