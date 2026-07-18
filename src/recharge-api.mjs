import { todayTimestampRange } from './profit-api.mjs'

const PAGE_SIZE = 100
const MAX_PAGES = 10000

const readJsonResponse = async (response) => {
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`本站 NewAPI 充值接口返回无效 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `本站 NewAPI 充值接口请求失败（HTTP ${response.status}）`)
  }
  return payload
}

const parseTopUpPage = (payload) => {
  const data = payload?.data
  if (Array.isArray(data)) {
    return { items: data, total: data.length, legacySinglePage: true }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('本站 NewAPI 充值接口缺少有效 data.items')
  }

  const total = Number(data.total)
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('本站 NewAPI 充值接口缺少有效 data.total')
  }
  return { items: data.items, total, legacySinglePage: false }
}

const orderKey = (order) => {
  if (order?.id !== null && order?.id !== undefined) return `id:${order.id}`
  const tradeNo = String(order?.trade_no || '').trim()
  return tradeNo ? `trade:${tradeNo}` : ''
}

const completedTimestamp = (order) => {
  const rawCompleteTime = order?.complete_time
  const completeTime = Number(rawCompleteTime)
  const raw = rawCompleteTime !== null
    && rawCompleteTime !== undefined
    && String(rawCompleteTime).trim() !== ''
    && Number.isFinite(completeTime)
    && completeTime > 0
    ? rawCompleteTime
    : order?.create_time
  const value = Number(raw)
  if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`充值订单 ${String(order?.trade_no || order?.id)} 的完成时间无效`)
  }
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
}

export const fetchNewApiRechargeStats = async ({
  baseUrl,
  accessToken,
  userId,
  timeZone = 'Asia/Shanghai',
  now = new Date(),
  fetchImpl = fetch,
}) => {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '')
  const token = String(accessToken || '').trim()
  const normalizedUserId = String(userId || '').trim()
  if (!normalizedBaseUrl) throw new Error('NEWAPI_BASE_URL 未配置')
  if (!token) throw new Error('NEWAPI_ACCESS_TOKEN 未配置')
  if (!/^\d+$/.test(normalizedUserId)) throw new Error('NEWAPI_USER_ID 未配置或格式无效')

  const headers = {
    Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
    'New-Api-User': normalizedUserId,
  }
  const seenOrders = new Set()
  const { startTimestamp, endTimestamp } = todayTimestampRange(now, timeZone)
  let expectedTotal = null
  let successfulOrderCount = 0
  let totalPaidCents = 0

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/user/topup', `${normalizedBaseUrl}/`)
    url.searchParams.set('p', String(page))
    url.searchParams.set('page_size', String(PAGE_SIZE))
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    })
    const parsedPage = parseTopUpPage(await readJsonResponse(response))

    if (expectedTotal === null) expectedTotal = parsedPage.total
    if (parsedPage.total !== expectedTotal) {
      throw new Error('充值订单在查询期间发生变化，请重试')
    }

    for (const order of parsedPage.items) {
      const key = orderKey(order)
      if (!key) throw new Error('本站 NewAPI 充值订单缺少 id 或 trade_no')
      if (seenOrders.has(key)) throw new Error('充值订单在查询期间发生变化，请重试')
      seenOrders.add(key)

      if (String(order?.status || '').toLowerCase() !== 'success') continue
      const completedAt = completedTimestamp(order)
      if (completedAt < startTimestamp || completedAt > endTimestamp) continue
      const rawMoney = order?.money
      const money = Number(rawMoney)
      if (rawMoney === null || rawMoney === undefined || String(rawMoney).trim() === '') {
        throw new Error(`充值订单 ${String(order?.trade_no || order?.id)} 的 money 无效`)
      }
      if (!Number.isFinite(money) || money < 0) {
        throw new Error(`充值订单 ${String(order?.trade_no || order?.id)} 的 money 无效`)
      }
      successfulOrderCount += 1
      totalPaidCents += Math.round(money * 100)
    }

    if (parsedPage.legacySinglePage || seenOrders.size >= expectedTotal) {
      if (seenOrders.size !== expectedTotal) {
        throw new Error('本站 NewAPI 充值订单分页数据不完整')
      }
      return {
        totalPaid: totalPaidCents / 100,
        successfulOrderCount,
      }
    }
    if (parsedPage.items.length === 0) {
      throw new Error('本站 NewAPI 充值订单分页数据不完整')
    }
  }

  throw new Error(`本站 NewAPI 充值订单超过 ${PAGE_SIZE * MAX_PAGES} 条，无法完成统计`)
}
