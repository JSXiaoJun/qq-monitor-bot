import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  createNotificationServer,
  formatBalanceMessage,
  formatProfitMessage,
  formatRatioMessage,
  formatRechargeMessage,
  highlightLowBalance,
  isAllowedGroupCommand,
  isAllowedQueryCommand,
} from '../src/notification-api.mjs'

const requestJson = (port, { path = '/api/notify', token = '', body } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
  const request = http.request({
    host: '127.0.0.1',
    port,
    path,
    method: data ? 'POST' : 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
    },
  }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({
      status: response.statusCode,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }))
  })
  request.on('error', reject)
  if (data) request.write(data)
  request.end()
})

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

test('notification API authenticates and sends only to configured group', async () => {
  const sent = []
  const server = createNotificationServer({
    apiToken: 'test-token',
    notificationGroupId: '123456789',
    isOneBotConnected: () => true,
    sendGroupMessage: async (groupId, message) => {
      sent.push({ groupId, message })
      return { message_id: 42 }
    },
    logger: { log() {}, error() {} },
  })
  const port = await listen(server)

  try {
    const unauthorized = await requestJson(port, { body: { message: 'test' } })
    assert.equal(unauthorized.status, 401)

    const wrongGroup = await requestJson(port, {
      token: 'test-token',
      body: { group_id: '987654321', message: 'test' },
    })
    assert.equal(wrongGroup.status, 403)

    const success = await requestJson(port, {
      token: 'test-token',
      body: { group_id: '123456789', subject: '倍率变化', message: 'default 1 -> 1.2' },
    })
    assert.equal(success.status, 200)
    assert.equal(success.body.message_id, 42)
    assert.deepEqual(sent, [{
      groupId: '123456789',
      message: '【倍率变化】\ndefault 1 -> 1.2',
    }])

    const bracketed = await requestJson(port, {
      token: 'test-token',
      body: { subject: '【NewAPI 低余额预警】站点A：¥9.68', message: '上游余额监控提醒' },
    })
    assert.equal(bracketed.status, 200)
    assert.equal(sent[1].message, '🔴【NewAPI 低余额预警】站点A：¥9.68\n🔴上游余额监控提醒')
  } finally {
    await close(server)
  }
})

test('low-balance highlight marks only the first two lines of low-balance alerts', () => {
  assert.equal(
    highlightLowBalance('【NewAPI 低余额预警】A：¥1.00\n上游余额监控提醒\n站点：A'),
    '🔴【NewAPI 低余额预警】A：¥1.00\n🔴上游余额监控提醒\n站点：A',
  )
  assert.equal(highlightLowBalance('🔴【低余额预警】A\n🔴提醒'), '🔴【低余额预警】A\n🔴提醒')
  assert.equal(highlightLowBalance('【倍率变化】\ndefault 1 -> 1.2'), '【倍率变化】\ndefault 1 -> 1.2')
})

test('query command is accepted only from the configured group', () => {
  const baseEvent = {
    post_type: 'message',
    message_type: 'group',
    group_id: 123456789,
    raw_message: ' 查监控 ',
  }
  assert.equal(isAllowedQueryCommand(baseEvent, '123456789', '查监控'), true)
  assert.equal(isAllowedQueryCommand({ ...baseEvent, group_id: 987654321 }, '123456789', '查监控'), false)
  assert.equal(isAllowedQueryCommand(baseEvent, '', '查监控'), false)
  assert.equal(isAllowedQueryCommand({ ...baseEvent, raw_message: '查余额' }, '123456789', '查监控'), false)
})

test('balance command is accepted only from notification group', () => {
  const event = {
    post_type: 'message',
    message_type: 'group',
    group_id: 987654321,
    raw_message: '查余额',
  }
  assert.equal(isAllowedGroupCommand(event, '987654321', '查余额'), true)
  assert.equal(isAllowedGroupCommand(event, '123456789', '查余额'), false)
})

test('balance message shows age only when valid data is older than ten minutes', () => {
  assert.equal(formatBalanceMessage([
    {
      name: '十分钟内',
      current_balance: 109.58,
      balance_currency: 'USD',
      balance_last_check_at: '2026-07-24T15:50:00+08:00',
    },
    {
      name: '超过十分钟',
      current_balance: 143.75,
      balance_currency: 'CNY',
      balance_last_check_at: '2026-07-24T15:49:59+08:00',
    },
    {
      name: '两小时前',
      current_balance: 20,
      balance_currency: 'RMB',
      balance_last_check_at: '2026-07-24T14:00:00+08:00',
    },
    {
      name: '暂无余额',
      current_balance: null,
      balance_currency: 'USD',
      balance_last_check_at: '2026-07-24T14:00:00+08:00',
    },
  ], new Date('2026-07-24T16:00:00+08:00')), [
    '【当前余额】',
    '十分钟内：$109.58',
    '超过十分钟：¥143.75（10分钟前）',
    '两小时前：¥20.00（2小时前）',
    '暂无余额：暂无数据',
  ].join('\n'))
})

test('ratio message groups selected rates by site without losing precision', () => {
  assert.equal(formatRatioMessage([
    {
      name: '超哥',
      groups: [
        { name: '分组1', ratio: 0.001, available: true },
        { name: '分组2', ratio: 0.002, available: true },
      ],
    },
    {
      name: '聪明',
      groups: [{ name: '精确分组', ratio: 0.015, available: true }],
    },
  ]), [
    '【当前倍率】',
    '超哥：',
    '分组1：0.001',
    '分组2：0.002',
    '聪明：',
    '精确分组：0.015',
  ].join('\n'))
})

test('profit message lists upstream usage and calculates totals with two decimals', () => {
  assert.equal(formatProfitMessage([
    { name: 'xx', success: true, amount: 123.11 },
    { name: 'ss', success: true, amount: 11.12 },
  ], 200), [
    '【利润】',
    'xx：123.11',
    'ss：11.12',
    '上游总和：134.23',
    '本站消耗：200.00',
    '利润：65.77',
  ].join('\n'))
})

test('profit message uses cached usage age and counts unavailable sites as zero', () => {
  assert.equal(formatProfitMessage([
    { name: '实时上游', success: true, cached: false, amount: 10 },
    {
      name: '缓存上游',
      success: true,
      cached: true,
      amount: 20.25,
      fetched_at: '2026-07-24T15:25:00+08:00',
      error: 'HTTP 403',
    },
    {
      name: '较早缓存上游',
      success: true,
      cached: true,
      amount: 4.75,
      fetched_at: '2026-07-24T14:00:00+08:00',
      error: '请求超时',
    },
    { name: '无记录上游', success: false, cached: false, amount: null, error: '请求超时' },
  ], 50, new Date('2026-07-24T16:00:00+08:00')), [
    '【利润】',
    '实时上游：10.00',
    '缓存上游：20.25（35分钟前）',
    '较早缓存上游：4.75（2小时前）',
    '无记录上游：查询失败（0）',
    '上游总和：35.00',
    '本站消耗：50.00',
    '利润：15.00',
  ].join('\n'))
})

test('recharge message shows actual paid total and successful order count', () => {
  assert.equal(formatRechargeMessage({
    totalPaid: 1234.5,
    successfulOrderCount: 18,
  }), [
    '【今日充值】',
    '今日实际付款总和：¥1234.50',
    '今日成功订单数：18',
  ].join('\n'))
})
