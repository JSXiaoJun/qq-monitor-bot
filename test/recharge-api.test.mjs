import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fetchNewApiRechargeStats } from '../src/recharge-api.mjs'

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

test('NewAPI recharge stats paginate all orders and sum only successful money', async () => {
  const requests = []
  const orders = [
    { id: 4, trade_no: 'paid-2', status: 'success', money: 20.2 },
    { id: 3, trade_no: 'pending', status: 'pending', money: 99 },
    { id: 2, trade_no: 'failed', status: 'failed', money: 88 },
    { id: 1, trade_no: 'paid-1', status: 'success', money: 10.1 },
  ]
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    const url = new URL(request.url, 'http://localhost')
    const page = Number(url.searchParams.get('p'))
    const items = page === 1 ? orders.slice(0, 2) : orders.slice(2)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      success: true,
      data: { page, page_size: 2, total: orders.length, items },
    }))
  })
  const port = await listen(server)

  try {
    const stats = await fetchNewApiRechargeStats({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
    })
    assert.deepEqual(stats, { totalPaid: 30.3, successfulOrderCount: 2 })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].headers.authorization, 'Bearer root-access-token')
    assert.equal(requests[0].headers['new-api-user'], '1')
    const firstUrl = new URL(requests[0].url, 'http://localhost')
    assert.equal(firstUrl.pathname, '/api/user/topup')
    assert.equal(firstUrl.searchParams.get('p'), '1')
    assert.equal(firstUrl.searchParams.get('page_size'), '100')
  } finally {
    await close(server)
  }
})

test('NewAPI recharge stats reject malformed successful order money', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      success: true,
      data: {
        page: 1,
        page_size: 100,
        total: 1,
        items: [{ id: 1, trade_no: 'bad-money', status: 'success', money: null }],
      },
    }))
  })
  const port = await listen(server)

  try {
    await assert.rejects(fetchNewApiRechargeStats({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
    }), /money 无效/)
  } finally {
    await close(server)
  }
})
