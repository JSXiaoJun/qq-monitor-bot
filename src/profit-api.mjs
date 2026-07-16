const DEFAULT_QUOTA_PER_UNIT = 500000

const findQuotaPerUnit = (value) => {
  if (!value || typeof value !== 'object') return null
  for (const [key, nested] of Object.entries(value)) {
    if (String(key).toLowerCase() === 'quota_per_unit') {
      const amount = Number(nested)
      if (Number.isFinite(amount) && amount > 0) return amount
    }
    const found = findQuotaPerUnit(nested)
    if (found) return found
  }
  return null
}

const timeZoneOffsetMs = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  )
  return asUtc - date.getTime()
}

export const todayTimestampRange = (now = new Date(), timeZone = 'Asia/Shanghai') => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  const approximateMidnight = new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
  ))
  const startMs = approximateMidnight.getTime() - timeZoneOffsetMs(approximateMidnight, timeZone)
  return {
    startTimestamp: Math.floor(startMs / 1000),
    endTimestamp: Math.floor(now.getTime() / 1000),
  }
}

const readJsonResponse = async (response, label) => {
  const text = await response.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${label}返回无效 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || `${label}请求失败（HTTP ${response.status}）`)
  }
  return payload
}

export const fetchNewApiTodayUsage = async ({
  baseUrl,
  accessToken,
  userId,
  quotaPerUnit = DEFAULT_QUOTA_PER_UNIT,
  timeZone = 'Asia/Shanghai',
  now = new Date(),
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

  const { startTimestamp, endTimestamp } = todayTimestampRange(now, timeZone)
  const statUrl = new URL('/api/log/stat', `${normalizedBaseUrl}/`)
  statUrl.searchParams.set('start_timestamp', String(startTimestamp))
  statUrl.searchParams.set('end_timestamp', String(endTimestamp))
  const headers = {
    Authorization: /^Bearer\s/i.test(token) ? token : `Bearer ${token}`,
    'New-Api-User': normalizedUserId,
  }
  const signal = AbortSignal.timeout(30000)
  const [statResponse, statusResponse] = await Promise.all([
    fetchImpl(statUrl, { headers, signal }),
    fetchImpl(new URL('/api/status', `${normalizedBaseUrl}/`), { signal }).catch(() => null),
  ])
  const statPayload = await readJsonResponse(statResponse, '本站 NewAPI 统计接口')
  const rawQuota = Number(statPayload?.data?.quota)
  if (!Number.isFinite(rawQuota)) throw new Error('本站 NewAPI 统计接口缺少有效 data.quota')

  let effectiveQuotaPerUnit = configuredUnit
  if (statusResponse?.ok) {
    try {
      const statusPayload = await statusResponse.json()
      effectiveQuotaPerUnit = findQuotaPerUnit(statusPayload) || configuredUnit
    } catch {
      // Use the configured fallback when an older NewAPI returns a non-JSON status page.
    }
  }
  return rawQuota / effectiveQuotaPerUnit
}
