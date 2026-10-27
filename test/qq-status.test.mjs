import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createNotificationServer } from '../src/notification-api.mjs'
import { createQqStatusTracker } from '../src/qq-status.mjs'

const getJson = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  }).on('error', reject)
})

const postNotify = (port, token, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body))
  const request = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/notify',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length },
  }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({
      status: response.statusCode,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }))
  })
  request.on('error', reject)
  request.end(data)
})

test('tracker follows heartbeat, bot_offline notice and get_status', () => {
  const tracker = createQqStatusTracker()
  assert.equal(tracker.snapshot().qq_online, null)

  assert.equal(tracker.observeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } }), true)
  assert.equal(tracker.snapshot().qq_online, true)
  assert.equal(tracker.observeEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } }), false)

  assert.equal(tracker.observeEvent({ post_type: 'notice', notice_type: 'bot_offline', tag: 'KickedOffLine', message: '账号在其他设备登录' }), true)
  assert.deepEqual(
    [tracker.snapshot().qq_online, tracker.snapshot().qq_status_reason],
    [false, '账号在其他设备登录'],
  )

  assert.equal(tracker.applyStatus({ online: true, good: true }), true)
  assert.equal(tracker.snapshot().qq_status_reason, '')

  assert.equal(tracker.observeEvent({ post_type: 'message', message_type: 'group' }), false)
  assert.equal(tracker.applyStatus({}), false)
  assert.equal(tracker.reset(), true)
  assert.equal(tracker.snapshot().qq_online, null)
})

test('health endpoint reports QQ login state separately from the WebSocket', async () => {
  let connected = true
  const tracker = createQqStatusTracker()
  const server = createNotificationServer({
    apiToken: 'token',
    notificationGroupId: '123456789',
    isOneBotConnected: () => connected,
    getQqStatus: () => tracker.snapshot(),
    sendGroupMessage: async () => ({}),
    logger: { log() {}, error() {} },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    tracker.applyStatus({ online: false })
    let health = await getJson(port, '/health')
    assert.equal(health.onebot_connected, true)
    assert.equal(health.qq_online, false)

    const rejected = await postNotify(port, 'token', { message: 'test' })
    assert.equal(rejected.status, 503)
    assert.match(rejected.body.message, /QQ 账号已离线/)

    tracker.applyStatus({ online: true })
    health = await getJson(port, '/health')
    assert.equal(health.qq_online, true)

    connected = false
    health = await getJson(port, '/health')
    assert.equal(health.qq_online, false)
    assert.equal(health.qq_status_reason, 'OneBot WebSocket 未连接')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
