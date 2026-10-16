import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TEMPLATES,
  formatBalanceMessage,
  formatGroupListMessage,
  formatProfitMessage,
  parseGroupCommand,
  renderTemplate,
  resolveCommandAlias,
} from '../src/notification-api.mjs'

const groupEvent = (rawMessage, groupId = 123456) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  raw_message: rawMessage,
})

const usageSites = [
  { name: '熊猫-画图', amount: 28.55, group_name: '画图' },
  { name: 'yuanqi-画图', amount: 1, group_name: '画图' },
  { name: '猫哥-国产', amount: 5.14, group_name: '国产' },
  { name: 'kimi', amount: null, group_name: '国产' },
  { name: 'coai-ccmax', amount: 31.3, group_name: null },
]

test('group command parses optional group filter and rejects lookalikes', () => {
  assert.deepEqual(parseGroupCommand(groupEvent('查利润'), '123456', '查利润'), { filter: '' })
  assert.deepEqual(parseGroupCommand(groupEvent(' 查利润  画图 '), '123456', '查利润'), { filter: '画图' })
  assert.equal(parseGroupCommand(groupEvent('查利润画图'), '123456', '查利润'), null)
  assert.equal(parseGroupCommand(groupEvent('查利润 画图', 999999), '123456', '查利润'), null)
})

test('profit message groups sites in payload order with subtotals and totals', () => {
  assert.equal(formatProfitMessage(usageSites, 100), [
    '【利润】',
    '▍画图',
    '熊猫-画图：28.55',
    'yuanqi-画图：1.00',
    '小计：29.55',
    '▍国产',
    '猫哥-国产：5.14',
    'kimi：查询失败（0）',
    '小计：5.14',
    '▍未分组',
    'coai-ccmax：31.30',
    '小计：31.30',
    '——————',
    '上游总和：65.99',
    '本站消耗：100.00',
    '利润：34.01',
  ].join('\n'))
})

test('profit message filtered by group shows only that group total', () => {
  assert.equal(formatProfitMessage(usageSites, 0, new Date(), { filter: '画图' }), [
    '【上游消耗 · 画图】',
    '熊猫-画图：28.55',
    'yuanqi-画图：1.00',
    '分组合计：29.55',
  ].join('\n'))
  assert.match(formatProfitMessage(usageSites, 0, new Date(), { filter: '视频' }), /未找到分组「视频」/)
})

test('balance message groups sites and adds subtotal per group', () => {
  const now = new Date('2026-10-16T03:00:00Z')
  const checkedAt = '2026-10-16T02:58:00Z'
  const sites = [
    { name: 'A', current_balance: 10, balance_currency: 'CNY', balance_last_check_at: checkedAt, group_name: 'claude' },
    { name: 'B', current_balance: 2.5, balance_currency: 'CNY', balance_last_check_at: checkedAt, group_name: 'claude' },
    { name: 'C', current_balance: null, group_name: 'gpt' },
  ]
  assert.equal(formatBalanceMessage(sites, now), [
    '【当前余额】',
    '▍claude',
    'A：¥10.00',
    'B：¥2.50',
    '小计：¥12.50',
    '▍gpt',
    'C：暂无数据',
  ].join('\n'))
  assert.equal(formatBalanceMessage(sites, now, { filter: 'GPT' }), [
    '【当前余额 · GPT】',
    '▍gpt',
    'C：暂无数据',
  ].join('\n'))
})

test('aliases rewrite the command head and keep trailing arguments', () => {
  const aliases = [
    { alias: '利润', target: '查利润' },
    { alias: '画图利润', target: '查利润 画图' },
  ]
  assert.equal(resolveCommandAlias('利润', aliases), '查利润')
  assert.equal(resolveCommandAlias(' 利润  国产 ', aliases), '查利润 国产')
  assert.equal(resolveCommandAlias('画图利润', aliases), '查利润 画图')
  assert.equal(resolveCommandAlias('查余额', aliases), '查余额')
  assert.equal(resolveCommandAlias('利润画图', aliases), '利润画图')
  assert.equal(resolveCommandAlias('利润', null), '利润')

  const event = { ...groupEvent('画图利润'), command_text: resolveCommandAlias('画图利润', aliases) }
  assert.deepEqual(parseGroupCommand(event, '123456', '查利润'), { filter: '画图' })
})

test('custom templates change layout, empty template omits the line, unknown keys are ignored', () => {
  const templates = {
    profit_title: '📊 今日利润',
    profit_group_header: '【{group}】{count}个',
    profit_site_line: '  {name} {amount}',
    profit_group_subtotal: '',
    profit_separator: '',
    profit_footer: '利润 {profit}（本站 {local_usage} / 上游 {upstream_total}）{typo}',
    not_a_template: 'x',
  }
  assert.equal(formatProfitMessage(usageSites.slice(0, 2), 50, new Date(), { templates }), [
    '📊 今日利润',
    '【画图】2个',
    '  熊猫-画图 28.55',
    '  yuanqi-画图 1.00',
    '利润 20.45（本站 50.00 / 上游 29.55）{typo}',
  ].join('\n'))
})

test('balance templates apply to grouped output', () => {
  const sites = [{ name: 'A', current_balance: 3, balance_currency: 'CNY', balance_last_check_at: new Date().toISOString(), group_name: 'gpt' }]
  assert.equal(formatBalanceMessage(sites, new Date(), {
    templates: { balance_title: '余额', balance_site_line: '{group}/{name}={balance}', balance_group_subtotal: '' },
  }), ['余额', '▍gpt', 'gpt/A=¥3.00'].join('\n'))
})

test('default templates reproduce the built-in format', () => {
  assert.equal(
    formatProfitMessage(usageSites, 100, new Date(), { templates: DEFAULT_TEMPLATES }),
    formatProfitMessage(usageSites, 100),
  )
  assert.equal(renderTemplate('{a}-{b}-{c}', { a: 1, b: '' }), '1--{c}')
})

test('group list message lists groups and their sites', () => {
  assert.equal(formatGroupListMessage(usageSites), [
    '【汇报分组】',
    '▍画图（2）',
    '熊猫-画图、yuanqi-画图',
    '▍国产（2）',
    '猫哥-国产、kimi',
    '▍未分组（1）',
    'coai-ccmax',
    '用法：查利润 分组名 / 查余额 分组名',
  ].join('\n'))
})
