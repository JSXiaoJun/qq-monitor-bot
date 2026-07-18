import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_LENGTH = 4000

export const normalizeGroupId = (value) => {
  const text = String(value ?? '').trim()
  return /^\d{5,20}$/.test(text) ? text : ''
}

export const isAllowedGroupCommand = (event, groupId, command) => event?.post_type === 'message'
  && event?.message_type === 'group'
  && Boolean(groupId)
  && String(event.group_id) === groupId
  && event.raw_message?.trim() === command

export const isAllowedQueryCommand = isAllowedGroupCommand

export const formatBalanceMessage = (sites) => {
  const lines = ['【当前余额】']
  if (!Array.isArray(sites) || sites.length === 0) {
    lines.push('暂无站点')
    return lines.join('\n')
  }

  for (const site of sites) {
    const name = String(site?.name || '未命名站点').trim()
    const balance = Number(site?.current_balance)
    const currency = String(site?.balance_currency || 'USD').trim().toUpperCase()
    let value = '暂无数据'
    if (site?.current_balance !== null && site?.current_balance !== undefined && Number.isFinite(balance)) {
      value = currency === 'USD' ? `$${balance.toFixed(2)}` : `${currency} ${balance.toFixed(2)}`
    }
    lines.push(`${name}：${value}`)
  }
  return lines.join('\n')
}

const formatRatioValue = (value) => {
  const ratio = Number(value)
  if (!Number.isFinite(ratio)) return '暂无数据'
  const text = ratio.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
  return text || '0'
}

export const formatRatioMessage = (sites) => {
  const lines = ['【当前倍率】']
  if (!Array.isArray(sites) || sites.length === 0) {
    lines.push('暂无启用站点')
    return lines.join('\n')
  }

  for (const site of sites) {
    lines.push(`${String(site?.name || '未命名站点').trim()}：`)
    if (!Array.isArray(site?.groups) || site.groups.length === 0) {
      lines.push(site?.error ? `检测失败：${site.error}` : '暂无已选分组')
      continue
    }
    for (const group of site.groups) {
      const value = group?.available === false ? '暂无数据' : formatRatioValue(group?.ratio)
      lines.push(`${String(group?.name || '未命名分组').trim()}：${value}`)
    }
  }
  return lines.join('\n')
}

export const formatProfitMessage = (sites, localUsage) => {
  if (!Array.isArray(sites)) throw new Error('上游今日消耗数据格式无效')
  const failed = sites.filter((site) => site?.success === false)
  if (failed.length > 0) {
    const details = failed
      .map((site) => `${String(site?.name || '未命名站点').trim()}（${site?.error || '查询失败'}）`)
      .join('、')
    throw new Error(`上游今日消耗查询不完整：${details}`)
  }

  const lines = ['【利润】']
  let upstreamTotal = 0
  for (const site of sites) {
    const amount = Number(site?.amount)
    if (!Number.isFinite(amount)) {
      throw new Error(`${String(site?.name || '未命名站点').trim()}缺少有效的今日消耗`)
    }
    upstreamTotal += amount
    lines.push(`${String(site?.name || '未命名站点').trim()}：${amount.toFixed(2)}`)
  }

  const normalizedLocalUsage = Number(localUsage)
  if (!Number.isFinite(normalizedLocalUsage)) throw new Error('本站今日消耗数据无效')
  lines.push(`上游总和：${upstreamTotal.toFixed(2)}`)
  lines.push(`本站消耗：${normalizedLocalUsage.toFixed(2)}`)
  lines.push(`利润：${(normalizedLocalUsage - upstreamTotal).toFixed(2)}`)
  return lines.join('\n')
}

export const formatRechargeMessage = (stats) => {
  const totalPaid = Number(stats?.totalPaid)
  const successfulOrderCount = Number(stats?.successfulOrderCount)
  if (!Number.isFinite(totalPaid) || totalPaid < 0) throw new Error('实际付款总和无效')
  if (!Number.isInteger(successfulOrderCount) || successfulOrderCount < 0) {
    throw new Error('成功充值订单数无效')
  }
  return [
    '【今日充值】',
    `今日实际付款总和：¥${totalPaid.toFixed(2)}`,
    `今日成功订单数：${successfulOrderCount}`,
  ].join('\n')
}

const tokensMatch = (expected, actual) => {
  const expectedBuffer = Buffer.from(expected || '')
  const actualBuffer = Buffer.from(actual || '')
  return expectedBuffer.length > 0
    && expectedBuffer.length === actualBuffer.length
    && timingSafeEqual(expectedBuffer, actualBuffer)
}

const sendJson = (response, statusCode, payload) => {
  const body = Buffer.from(JSON.stringify(payload))
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  })
  response.end(body)
}

const readJsonBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0

  request.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      reject(new Error('请求体过大'))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    } catch {
      reject(new Error('请求体不是有效 JSON'))
    }
  })
  request.on('error', reject)
})

export const createNotificationServer = ({
  apiToken,
  notificationGroupId,
  isOneBotConnected,
  sendGroupMessage,
  logger = console,
}) => createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://localhost')

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(response, 200, {
      success: true,
      onebot_connected: Boolean(isOneBotConnected()),
      notification_group_configured: Boolean(notificationGroupId),
    })
  }

  if (request.method !== 'POST' || requestUrl.pathname !== '/api/notify') {
    return sendJson(response, 404, { success: false, message: 'Not found' })
  }

  const authorization = String(request.headers.authorization || '')
  const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!tokensMatch(apiToken, suppliedToken)) {
    return sendJson(response, 401, { success: false, message: '通知接口鉴权失败' })
  }

  if (!notificationGroupId) {
    return sendJson(response, 503, { success: false, message: 'NOTIFY_GROUP_ID 未配置' })
  }
  if (!isOneBotConnected()) {
    return sendJson(response, 503, { success: false, message: 'OneBot WebSocket 未连接' })
  }

  try {
    const body = await readJsonBody(request)
    const requestedGroupId = normalizeGroupId(body.group_id || notificationGroupId)
    if (!requestedGroupId) {
      return sendJson(response, 400, { success: false, message: 'group_id 格式无效' })
    }
    if (requestedGroupId !== notificationGroupId) {
      return sendJson(response, 403, { success: false, message: '目标群不在允许的通知范围内' })
    }

    const subject = String(body.subject || '').trim()
    const message = String(body.message || '').trim()
    if (!subject && !message) {
      return sendJson(response, 400, { success: false, message: 'subject 和 message 不能同时为空' })
    }

    const content = [subject ? `【${subject}】` : '', message].filter(Boolean).join('\n')
    if (content.length > MAX_MESSAGE_LENGTH) {
      return sendJson(response, 400, { success: false, message: `消息长度不能超过 ${MAX_MESSAGE_LENGTH} 个字符` })
    }

    const result = await sendGroupMessage(notificationGroupId, content)
    logger.log(`通知已发送到群 ${notificationGroupId}`)
    return sendJson(response, 200, {
      success: true,
      group_id: notificationGroupId,
      message_id: result?.message_id ?? null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('通知接口发送失败:', message)
    const statusCode = message.includes('JSON') || message.includes('请求体') ? 400 : 502
    return sendJson(response, statusCode, { success: false, message })
  }
})
