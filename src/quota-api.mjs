import { DEFAULT_QUOTA_PER_UNIT, findQuotaPerUnit } from './profit-api.mjs'

export const DEFAULT_NEGATIVE_QUOTA_THRESHOLD = 5

const PAGE_SIZE = 100
const MAX_PAGES = 10000

const readJsonResponse = async (response) => {
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`本站 NewAPI 用户接口返回无效 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `本站 NewAPI 用户接口请求失败（HTTP ${response.status}）`)
  }
  return payload
}

const parseUserPage = (payload) => {
  const data = payload?.data
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new Error('本站 NewAPI 用户接口缺少有效 data.items')
  }
  const total = Number(data.total)
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('本站 NewAPI 用户接口缺少有效 data.total')
  }
  return { items: data.items, total }
}

const isSoftDeleted = (user) => {
  const deletedAt = user?.DeletedAt ?? user?.deleted_at
  return deletedAt !== null && deletedAt !== undefined && deletedAt !== ''
}

const fetchNewApiActiveUsers = async ({
  baseUrl,
  accessToken,
  userId,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT,
  fetchImpl = fetch,
}) => {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/, '')
  const token = String(accessToken || '').trim()
  const normalizedUserId = String(userId || '').trim()
  const configuredUnit = Number(quotaPerUnit)
  if (!normalizedBaseUrl) throw new Error('NEWAPI_BASE_URL 未配置')
  if (!token) throw new Error('NEWAPI_ACCESS_TOKEN 未配置')
  if (!/^\d+$/.test(normalizedUserId)) throw new Error('NEWAPI_USER_ID 未配置或格式无效')
  if (!Number.isFinite(configuredUnit) || configuredUnit <= 0) {
    throw new Error('NEWAPI_QUOTA_PER_UNIT 必须是正数')
  }

  const headers = {
    Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
    'New-Api-User': normalizedUserId,
  }
  const statusPromise = fetchImpl(new URL('/api/status', `${normalizedBaseUrl}/`), {
    signal: AbortSignal.timeout(30000),
  }).catch(() => null)

  const seenUsers = new Set()
  const users = []
  let expectedTotal = null

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/api/user/', `${normalizedBaseUrl}/`)
    url.searchParams.set('p', String(page))
    url.searchParams.set('page_size', String(PAGE_SIZE))
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    })
    const parsedPage = parseUserPage(await readJsonResponse(response))

    if (expectedTotal === null) expectedTotal = parsedPage.total
    if (parsedPage.total !== expectedTotal) {
      throw new Error('用户列表在查询期间发生变化，请重试')
    }

    for (const user of parsedPage.items) {
      const id = user?.id
      if (id === null || id === undefined || String(id).trim() === '') {
        throw new Error('本站 NewAPI 用户缺少 id')
      }
      const key = String(id)
      if (seenUsers.has(key)) throw new Error('用户列表在查询期间发生变化，请重试')
      seenUsers.add(key)

      if (isSoftDeleted(user)) continue
      const quota = Number(user?.quota)
      if (!Number.isFinite(quota)) throw new Error(`用户 ${key} 的 quota 无效`)
      users.push({ id: key, quota })
    }

    if (seenUsers.size >= expectedTotal) {
      if (seenUsers.size !== expectedTotal) {
        throw new Error('本站 NewAPI 用户分页数据不完整')
      }
      let effectiveQuotaPerUnit = configuredUnit
      const statusResponse = await statusPromise
      if (statusResponse?.ok) {
        try {
          effectiveQuotaPerUnit = findQuotaPerUnit(await statusResponse.json()) || configuredUnit
        } catch {
          // Use the configured fallback when an older NewAPI returns a non-JSON status page.
        }
      }
      return { users, quotaPerUnit: effectiveQuotaPerUnit }
    }
    if (parsedPage.items.length === 0) {
      throw new Error('本站 NewAPI 用户分页数据不完整')
    }
  }

  throw new Error(`本站 NewAPI 用户超过 ${PAGE_SIZE * MAX_PAGES} 个，无法完成统计`)
}

export const fetchNewApiPositiveQuotaTotal = async ({ excludeUserIds = [1], ...options }) => {
  const { users, quotaPerUnit } = await fetchNewApiActiveUsers(options)
  const excluded = new Set(excludeUserIds.map((id) => String(id)))
  let totalQuota = 0
  let positiveUserCount = 0
  for (const user of users) {
    if (excluded.has(user.id) || user.quota <= 0) continue
    positiveUserCount += 1
    totalQuota += user.quota
  }
  return {
    totalQuota,
    totalAmount: totalQuota / quotaPerUnit,
    positiveUserCount,
  }
}

export const fetchNewApiNegativeQuotaUsers = async ({ threshold = DEFAULT_NEGATIVE_QUOTA_THRESHOLD, ...options }) => {
  const limit = Number(threshold)
  if (!Number.isFinite(limit) || limit < 0) throw new Error('负额度阈值必须是非负数')
  const { users, quotaPerUnit } = await fetchNewApiActiveUsers(options)
  const userIds = users
    .filter((user) => user.quota / quotaPerUnit < -limit)
    .map((user) => user.id)
    .sort((a, b) => Number(a) - Number(b))
  return { threshold: limit, userIds }
}
