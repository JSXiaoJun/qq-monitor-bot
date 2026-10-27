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
  && String(event.command_text ?? event.raw_message ?? '').trim() === command

export const isAllowedQueryCommand = isAllowedGroupCommand

export const parseGroupCommand = (event, groupId, command) => {
  if (event?.post_type !== 'message' || event?.message_type !== 'group') return null
  if (!groupId || String(event.group_id) !== groupId) return null
  const text = String(event.command_text ?? event.raw_message ?? '').trim()
  if (text === command) return { filter: '' }
  if (!text.startsWith(command)) return null
  const rest = text.slice(command.length)
  if (!/^\s/.test(rest)) return null
  return { filter: rest.trim() }
}

// Must stay identical to DEFAULT_BOT_TEMPLATES in upstream-ratio-watch/app.py.
export const DEFAULT_TEMPLATES = Object.freeze({
  profit_title: '【利润】',
  profit_group_header: '▍{group}',
  profit_site_line: '{name}：{amount}{age}',
  profit_site_failed: '{name}：查询失败（0）',
  profit_group_subtotal: '小计：{subtotal}',
  profit_separator: '——————',
  profit_footer: '上游总和：{upstream_total}\n本站消耗：{local_usage}\n利润：{profit}',
  profit_filter_title: '【上游消耗 · {group}】',
  profit_filter_footer: '分组合计：{total}',
  balance_title: '【当前余额】',
  balance_filter_title: '【当前余额 · {group}】',
  balance_group_header: '▍{group}',
  balance_site_line: '{name}：{balance}{age}',
  balance_site_missing: '{name}：暂无数据',
  balance_group_subtotal: '小计：{subtotal}',
})

export const resolveTemplates = (overrides) => {
  const templates = { ...DEFAULT_TEMPLATES }
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (key in DEFAULT_TEMPLATES && typeof value === 'string') templates[key] = value
    }
  }
  return templates
}

// Unknown placeholders are left as-is so a typo shows up in the message instead of vanishing.
export const renderTemplate = (template, values) => String(template ?? '')
  .replace(/\{([A-Za-z_]+)\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key] ?? '') : match))

// An empty rendered template means "omit this line".
const pushRendered = (lines, template, values) => {
  const text = renderTemplate(template, values)
  if (text !== '') lines.push(text)
}

export const resolveCommandAlias = (text, aliases) => {
  const message = String(text || '').trim()
  if (!Array.isArray(aliases) || !message) return message
  const [head, ...rest] = message.split(/\s+/)
  const entry = aliases.find((item) => String(item?.alias || '').trim() === head)
  const target = String(entry?.target || '').trim()
  if (!target) return message
  return rest.length ? `${target} ${rest.join(' ')}` : target
}

const UNGROUPED_NAME = '未分组'

const groupNameOf = (site) => String(site?.group_name || '').trim() || UNGROUPED_NAME

export const groupSites = (sites) => {
  const groups = []
  const byName = new Map()
  for (const site of Array.isArray(sites) ? sites : []) {
    const name = groupNameOf(site)
    if (!byName.has(name)) {
      const group = { name, sites: [] }
      byName.set(name, group)
      groups.push(group)
    }
    byName.get(name).sites.push(site)
  }
  return groups
}

export const filterSitesByGroup = (sites, filter) => {
  const keyword = String(filter || '').trim().toLowerCase()
  if (!keyword) return sites
  return (Array.isArray(sites) ? sites : []).filter((site) => groupNameOf(site).toLowerCase() === keyword)
}

// Displays the group's real name ("GPT") instead of whatever casing the user typed ("gpt").
const displayFilterName = (sites, filter) => (sites.length ? groupNameOf(sites[0]) : filter)

const hasGroupInfo = (sites) => Array.isArray(sites) && sites.some((site) => String(site?.group_name || '').trim())

const currencySymbol = (currency) => (currency === 'USD' ? '$' : ['CNY', 'RMB'].includes(currency) ? '¥' : `${currency} `)

const siteName = (site) => String(site?.name || '未命名站点').trim()

const balanceLine = (site, now, templates, group) => {
  const name = siteName(site)
  const balance = Number(site?.current_balance)
  const currency = String(site?.balance_currency || 'USD').trim().toUpperCase()
  if (site?.current_balance === null || site?.current_balance === undefined || !Number.isFinite(balance)) {
    return { template: templates.balance_site_missing, values: { name, group }, amount: null, currency }
  }
  const checkedTime = Date.parse(String(site?.balance_last_check_at || ''))
  const elapsedMs = Number.isFinite(checkedTime) ? Math.max(0, now.getTime() - checkedTime) : 0
  const age = elapsedMs > 10 * 60 * 1000 ? `（${formatUsageAge(site.balance_last_check_at, now)}）` : ''
  return {
    template: templates.balance_site_line,
    values: { name, group, balance: `${currencySymbol(currency)}${balance.toFixed(2)}`, age },
    amount: balance,
    currency,
  }
}

export const formatBalanceMessage = (sites, now = new Date(), { filter = '', templates: overrides } = {}) => {
  const templates = resolveTemplates(overrides)
  const lines = []
  const selected = filterSitesByGroup(sites, filter)
  const groupLabel = filter && Array.isArray(selected) ? displayFilterName(selected, filter) : filter
  pushRendered(lines, filter ? templates.balance_filter_title : templates.balance_title, { group: groupLabel })
  if (!Array.isArray(selected) || selected.length === 0) {
    lines.push(filter ? `未找到分组「${filter}」，发送“查分组”查看全部分组` : '暂无站点')
    return lines.join('\n')
  }

  if (!hasGroupInfo(selected)) {
    for (const site of selected) {
      const line = balanceLine(site, now, templates, '')
      pushRendered(lines, line.template, line.values)
    }
    return lines.join('\n')
  }

  for (const group of groupSites(selected)) {
    pushRendered(lines, templates.balance_group_header, { group: group.name, count: group.sites.length })
    let subtotal = 0
    let subtotalCurrency = null
    let mixedCurrency = false
    for (const site of group.sites) {
      const line = balanceLine(site, now, templates, group.name)
      pushRendered(lines, line.template, line.values)
      if (line.amount === null) continue
      if (subtotalCurrency && subtotalCurrency !== line.currency) mixedCurrency = true
      subtotalCurrency = subtotalCurrency || line.currency
      subtotal += line.amount
    }
    if (subtotalCurrency && !mixedCurrency) {
      pushRendered(lines, templates.balance_group_subtotal, {
        group: group.name,
        count: group.sites.length,
        subtotal: `${currencySymbol(subtotalCurrency)}${subtotal.toFixed(2)}`,
      })
    }
  }
  return lines.join('\n')
}

export const formatGroupListMessage = (sites) => {
  const lines = ['【汇报分组】']
  const groups = groupSites(sites)
  if (groups.length === 0) {
    lines.push('暂无站点')
    return lines.join('\n')
  }
  for (const group of groups) {
    const names = group.sites.map((site) => String(site?.name || '未命名站点').trim())
    lines.push(`▍${group.name}（${names.length}）`)
    lines.push(names.join('、'))
  }
  lines.push('用法：查利润 分组名 / 查余额 分组名')
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

const formatUsageAge = (fetchedAt, now) => {
  const fetchedTime = Date.parse(String(fetchedAt || ''))
  if (!Number.isFinite(fetchedTime)) return '时间未知'
  const elapsedMs = Math.max(0, now.getTime() - fetchedTime)
  if (elapsedMs < 60 * 1000) return '刚刚'
  if (elapsedMs < 60 * 60 * 1000) return `${Math.floor(elapsedMs / (60 * 1000))}分钟前`
  if (elapsedMs < 24 * 60 * 60 * 1000) return `${Math.floor(elapsedMs / (60 * 60 * 1000))}小时前`
  return `${Math.floor(elapsedMs / (24 * 60 * 60 * 1000))}天前`
}

const usageLine = (site, now, templates, group) => {
  const name = siteName(site)
  const amount = Number(site?.amount)
  if (site?.amount === null || site?.amount === undefined || !Number.isFinite(amount)) {
    return { template: templates.profit_site_failed, values: { name, group }, amount: 0 }
  }
  const age = site?.cached ? `（${formatUsageAge(site.fetched_at, now)}）` : ''
  return { template: templates.profit_site_line, values: { name, group, amount: amount.toFixed(2), age }, amount }
}

export const formatProfitMessage = (sites, localUsage, now = new Date(), { filter = '', templates: overrides } = {}) => {
  if (!Array.isArray(sites)) throw new Error('上游今日消耗数据格式无效')
  const templates = resolveTemplates(overrides)

  const selected = filterSitesByGroup(sites, filter)
  if (filter) {
    const lines = []
    const groupLabel = displayFilterName(selected, filter)
    pushRendered(lines, templates.profit_filter_title, { group: groupLabel })
    if (selected.length === 0) {
      lines.push(`未找到分组「${filter}」，发送“查分组”查看全部分组`)
      return lines.join('\n')
    }
    let groupTotal = 0
    for (const site of selected) {
      const line = usageLine(site, now, templates, groupLabel)
      pushRendered(lines, line.template, line.values)
      groupTotal += line.amount
    }
    pushRendered(lines, templates.profit_filter_footer, { group: groupLabel, total: groupTotal.toFixed(2) })
    return lines.join('\n')
  }

  const lines = []
  pushRendered(lines, templates.profit_title, {})
  let upstreamTotal = 0
  const grouped = hasGroupInfo(sites)
  if (grouped) {
    for (const group of groupSites(sites)) {
      pushRendered(lines, templates.profit_group_header, { group: group.name, count: group.sites.length })
      let subtotal = 0
      for (const site of group.sites) {
        const line = usageLine(site, now, templates, group.name)
        pushRendered(lines, line.template, line.values)
        subtotal += line.amount
      }
      upstreamTotal += subtotal
      pushRendered(lines, templates.profit_group_subtotal, {
        group: group.name,
        count: group.sites.length,
        subtotal: subtotal.toFixed(2),
      })
    }
  } else {
    for (const site of sites) {
      const line = usageLine(site, now, templates, '')
      pushRendered(lines, line.template, line.values)
      upstreamTotal += line.amount
    }
  }

  const normalizedLocalUsage = Number(localUsage)
  if (!Number.isFinite(normalizedLocalUsage)) throw new Error('本站今日消耗数据无效')
  if (grouped) pushRendered(lines, templates.profit_separator, {})
  pushRendered(lines, templates.profit_footer, {
    upstream_total: upstreamTotal.toFixed(2),
    local_usage: normalizedLocalUsage.toFixed(2),
    profit: (normalizedLocalUsage - upstreamTotal).toFixed(2),
  })
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

export const formatQuotaTotalMessage = (stats) => {
  const totalAmount = Number(stats?.totalAmount)
  const positiveUserCount = Number(stats?.positiveUserCount)
  if (!Number.isFinite(totalAmount) || totalAmount < 0) throw new Error('用户额度总和无效')
  if (!Number.isInteger(positiveUserCount) || positiveUserCount < 0) {
    throw new Error('有余额用户数无效')
  }
  return [
    '【用户总额度】',
    `用户余额总和：${totalAmount.toFixed(2)}`,
    `有余额用户数：${positiveUserCount}`,
    '（仅统计额度为正的用户，已排除 ID 1）',
  ].join('\n')
}

export const formatNegativeQuotaMessage = (result) => {
  const threshold = Number(result?.threshold)
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('负额度阈值无效')
  if (!Array.isArray(result?.userIds)) throw new Error('负额度用户列表无效')
  const title = `【负额度用户】（欠费超过 ${threshold.toFixed(2)}）`
  if (result.userIds.length === 0) return [title, '暂无'].join('\n')
  return [
    title,
    result.userIds.join(','),
    `共 ${result.userIds.length} 人`,
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
  getQqStatus = () => ({ qq_online: null }),
  sendGroupMessage,
  logger = console,
}) => createServer(async (request, response) => {
  const requestUrl = new URL(request.url || '/', 'http://localhost')

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    const connected = Boolean(isOneBotConnected())
    const qqStatus = getQqStatus() || {}
    return sendJson(response, 200, {
      success: true,
      onebot_connected: connected,
      // null means NapCat has not reported yet; false means the account is logged out.
      qq_online: connected ? (qqStatus.qq_online ?? null) : false,
      qq_status_reason: connected ? (qqStatus.qq_status_reason || '') : 'OneBot WebSocket 未连接',
      qq_status_changed_at: qqStatus.qq_status_changed_at || null,
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
  const qqStatus = getQqStatus() || {}
  if (qqStatus.qq_online === false) {
    const reason = qqStatus.qq_status_reason ? `：${qqStatus.qq_status_reason}` : ''
    return sendJson(response, 503, { success: false, message: `QQ 账号已离线${reason}` })
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
