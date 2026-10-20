import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { formatNegativeQuotaMessage, formatQuotaTotalMessage } from '../src/notification-api.mjs'
import { fetchNewApiNegativeQuotaUsers, fetchNewApiPositiveQuotaTotal } from '../src/quota-api.mjs'

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

const jsonServer = (handler) => createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  const body = handler(url, request)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
})

test('quota total paginates all users and sums only positive quotas excluding ID 1', async () => {
  const requests = []
  const users = [
    { id: 6, quota: 1000000, DeletedAt: null },
    { id: 5, quota: -250000, DeletedAt: null },
    { id: 4, quota: 0, DeletedAt: null },
    { id: 3, quota: 800000, DeletedAt: '2026-07-01T00:00:00Z' },
    { id: 2, quota: 250000, DeletedAt: null },
    { id: 1, quota: 99000000, DeletedAt: null },
  ]
  const server = jsonServer((url, request) => {
    requests.push({ url, headers: request.headers })
    if (url.pathname === '/api/status') {
      return { success: true, data: { quota_per_unit: 500000 } }
    }
    const page = Number(url.searchParams.get('p'))
    const items = page === 1 ? users.slice(0, 4) : users.slice(4)
    return { success: true, data: { page, page_size: 4, total: users.length, items } }
  })
  const port = await listen(server)

  try {
    const stats = await fetchNewApiPositiveQuotaTotal({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
      quotaPerUnit: 1,
    })
    assert.deepEqual(stats, { totalQuota: 1250000, totalAmount: 2.5, positiveUserCount: 2 })
    const userRequests = requests.filter(({ url }) => url.pathname === '/api/user/')
    assert.equal(userRequests.length, 2)
    assert.equal(userRequests[0].headers.authorization, 'Bearer root-access-token')
    assert.equal(userRequests[0].headers['new-api-user'], '1')
    assert.equal(userRequests[0].url.searchParams.get('page_size'), '100')
  } finally {
    await close(server)
  }
})

test('quota total rejects user lists that change while paginating', async () => {
  const server = jsonServer((url) => {
    if (url.pathname === '/api/status') return { success: true, data: {} }
    const page = Number(url.searchParams.get('p'))
    return {
      success: true,
      data: { page, total: page === 1 ? 2 : 3, items: [{ id: page + 1, quota: 1 }] },
    }
  })
  const port = await listen(server)

  try {
    await assert.rejects(fetchNewApiPositiveQuotaTotal({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
    }), /发生变化/)
  } finally {
    await close(server)
  }
})

test('quota total surfaces NewAPI permission errors', async () => {
  const server = jsonServer(() => ({ success: false, message: '无权进行此操作，权限不足' }))
  const port = await listen(server)

  try {
    await assert.rejects(fetchNewApiPositiveQuotaTotal({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'user-token',
      userId: '1',
    }), /权限不足/)
  } finally {
    await close(server)
  }
})

test('quota total message shows amount and user count', () => {
  assert.equal(formatQuotaTotalMessage({ totalAmount: 5678.9, positiveUserCount: 42 }), [
    '【用户总额度】',
    '用户余额总和：5678.90',
    '有余额用户数：42',
    '（仅统计额度为正的用户，已排除 ID 1）',
  ].join('\n'))
})

test('negative quota lists users owing more than the threshold sorted by ID', async () => {
  const users = [
    { id: 30, quota: -3000000, DeletedAt: null },
    { id: 21, quota: -2500000, DeletedAt: null },
    { id: 9, quota: -2500001, DeletedAt: null },
    { id: 8, quota: -9000000, DeletedAt: '2026-07-01T00:00:00Z' },
    { id: 4, quota: 1000000, DeletedAt: null },
    { id: 1, quota: -5000000, DeletedAt: null },
  ]
  const server = jsonServer((url) => {
    if (url.pathname === '/api/status') return { success: true, data: { quota_per_unit: 500000 } }
    return { success: true, data: { page: 1, total: users.length, items: users } }
  })
  const port = await listen(server)

  try {
    const result = await fetchNewApiNegativeQuotaUsers({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
      threshold: 5,
    })
    assert.deepEqual(result, { threshold: 5, userIds: ['1', '9', '30'] })
  } finally {
    await close(server)
  }
})

test('negative quota rejects an invalid threshold before querying', async () => {
  await assert.rejects(fetchNewApiNegativeQuotaUsers({
    baseUrl: 'http://127.0.0.1:9',
    accessToken: 'root-access-token',
    userId: '1',
    threshold: -1,
  }), /阈值/)
})

test('negative quota message joins IDs with commas', () => {
  assert.equal(formatNegativeQuotaMessage({ threshold: 5, userIds: ['12', '57', '203'] }), [
    '【负额度用户】（欠费超过 5.00）',
    '12,57,203',
    '共 3 人',
  ].join('\n'))
  assert.equal(formatNegativeQuotaMessage({ threshold: 5, userIds: [] }), [
    '【负额度用户】（欠费超过 5.00）',
    '暂无',
  ].join('\n'))
})
