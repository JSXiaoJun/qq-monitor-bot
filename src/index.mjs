import 'dotenv/config'
import process from 'node:process'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const monitorUrl = 'https://status.yyapi.cloud/status/ai-status'
const onebotUrl = process.env.ONEBOT_WS_URL || 'ws://127.0.0.1:3001'
const command = process.env.COMMAND || '查监控'
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

const sendGroupMessage = (groupId, message) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('OneBot WebSocket 未连接')

  ws.send(JSON.stringify({
    action: 'send_group_msg',
    params: {
      group_id: groupId,
      message,
    },
  }))
}

const capture = async () => {
  const page = await browser.newPage({ viewport })

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

const handleMessage = (event) => {
  if (event.post_type !== 'message' || event.message_type !== 'group') return
  if (event.raw_message?.trim() !== command) return
  if (seenMessages.has(event.message_id)) return

  seenMessages.add(event.message_id)
  if (seenMessages.size > 1000) seenMessages.delete(seenMessages.values().next().value)

  queue = queue
    .then(async () => {
      console.log(`收到群 ${event.group_id} 的截图请求`)
      const image = await capture()
      sendGroupMessage(event.group_id, [{
        type: 'image',
        data: {
          file: `base64://${image.toString('base64')}`,
        },
      }])
    })
    .catch((err) => {
      console.error('截图或发送失败:', err)
      try {
        sendGroupMessage(event.group_id, '截图失败，请稍后重试')
      } catch (sendErr) {
        console.error('发送失败提示时出错:', sendErr)
      }
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
      handleMessage(JSON.parse(data.toString()))
    } catch (err) {
      console.warn('忽略无法解析的 OneBot 消息:', err.message)
    }
  })

  ws.on('error', (err) => {
    console.error('OneBot WebSocket 错误:', err.message)
  })

  ws.on('close', () => {
    if (stopping) return
    console.warn('OneBot 连接已断开，5 秒后重连')
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 5000)
  })
}

const shutdown = async () => {
  stopping = true
  clearTimeout(reconnectTimer)
  ws?.close()
  await queue.catch(() => {})
  await browser.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

connect()
