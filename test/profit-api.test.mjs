import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fetchNewApiTodayUsage, todayTimestampRange } from '../src/profit-api.mjs'

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const close = (server) => new Promise((resolve) => server.close(resolve))

test('Shanghai today range starts at local midnight', () => {
  const now = new Date('2026-07-16T10:30:45.000Z')
  assert.deepEqual(todayTimestampRange(now), {
    startTimestamp: Date.parse('2026-07-15T16:00:00.000Z') / 1000,
    endTimestamp: Date.parse('2026-07-16T10:30:45.000Z') / 1000,
  })
})

test('NewAPI today usage queries admin statistics and converts quota to amount', async () => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers })
    const payload = request.url.startsWith('/api/log/stat?')
      ? { success: true, data: { quota: 6_250_000 } }
      : { success: true, data: { quota_per_unit: 500_000 } }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  const port = await listen(server)

  try {
    const amount = await fetchNewApiTodayUsage({
      baseUrl: `http://127.0.0.1:${port}`,
      accessToken: 'root-access-token',
      userId: '1',
      now: new Date('2026-07-16T10:30:45.000Z'),
    })
    assert.equal(amount, 12.5)
    const statRequest = requests.find((request) => request.url.startsWith('/api/log/stat?'))
    assert.equal(statRequest.headers.authorization, 'Bearer root-access-token')
    assert.equal(statRequest.headers['new-api-user'], '1')
    const statUrl = new URL(statRequest.url, 'http://localhost')
    assert.equal(statUrl.searchParams.get('start_timestamp'), String(Date.parse('2026-07-15T16:00:00.000Z') / 1000))
    assert.equal(statUrl.searchParams.get('end_timestamp'), String(Date.parse('2026-07-16T10:30:45.000Z') / 1000))
  } finally {
    await close(server)
  }
})
