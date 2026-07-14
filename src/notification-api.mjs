import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGE_LENGTH = 4000

export const normalizeGroupId = (value) => {
  const text = String(value ?? '').trim()
  return /^\d{5,20}$/.test(text) ? text : ''
}

export const isAllowedQueryCommand = (event, queryGroupId, command) => event?.post_type === 'message'
  && event?.message_type === 'group'
  && Boolean(queryGroupId)
  && String(event.group_id) === queryGroupId
  && event.raw_message?.trim() === command

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
