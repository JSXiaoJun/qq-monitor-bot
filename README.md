# QQ 群监控截图机器人

指定查询群的成员发送精确指令 `查监控` 后，机器人先发送公开状态页地址 `https://status.yyapi.cloud/status/ai-status`，再打开该固定页面截图并发回查询群。服务通过 OneBot 11 WebSocket 与 NapCatQQ 等 QQ 机器人框架通信，并提供受 Token 保护的 HTTP 接口，将上游监控通知发送到独立指定群。

## 1. Linux Docker 部署

项目的 Compose 同时运行 NapCatQQ 和截图机器人。NapCat 的 OneBot 端口只在 Docker 私有网络内使用，不占用宿主机端口。

```bash
git clone https://github.com/JSXiaoJun/qq-monitor-bot.git
cd qq-monitor-bot
cp .env.example .env
sed -i 's/^NAPCAT_ACCOUNT=$/NAPCAT_ACCOUNT=你的机器人QQ号/' .env
docker network create qq-notify
docker compose up -d --build
docker compose logs -f napcat
```

NapCat WebUI 只监听服务器本机的 `6099` 端口。在自己的电脑上建立 SSH 隧道：

```bash
ssh -L 6099:127.0.0.1:6099 root@服务器IP
```

然后浏览器打开 `http://127.0.0.1:6099/webui`。默认登录 Token 为 `napcat`，登录后应立即修改。

## 2. 登录 QQ 并配置 OneBot

1. 首次启动时扫描 NapCat 日志中的二维码登录 QQ 小号。
2. `NAPCAT_ACCOUNT` 会在后续启动时使用持久化凭据快速登录。
3. Compose 自动创建监听 `0.0.0.0:3001` 的 OneBot 11 WebSocket 服务。
4. 如需设置 Access Token，同时配置 NapCat 和项目 `.env` 中的 `ONEBOT_ACCESS_TOKEN`。

```bash
docker compose restart napcat monitor-bot
docker compose logs -f monitor-bot
```

在 `.env` 中必须设置三个通知相关参数：

```dotenv
# 只有这个群能触发“查监控”
QUERY_GROUP_ID=查询群号

# 上游倍率和余额通知固定发送到这个群
NOTIFY_GROUP_ID=通知群号

# 使用 openssl rand -hex 32 生成，两边项目必须填写同一个值
NOTIFY_API_TOKEN=强随机Token
```

查询群和通知群可以相同，也可以不同。日志显示 `已连接 OneBot: ws://napcat:3001` 后，只在 `QUERY_GROUP_ID` 对应群发送精确指令 `查监控` 才会触发截图。

在 `NOTIFY_GROUP_ID` 对应的通知群发送精确指令 `查余额`，机器人会通过共享 Docker 网络读取监控面板已经采集的全部站点余额，并回复：

```text
【当前余额】
站点A：$12.34
站点B：$56.78
```

余额查询不会主动检测上游，返回的是监控面板最近一次保存的余额。

在通知群发送精确指令 `查倍率`，机器人会立即并行检测全部启用站点，并按各站点在监控面板勾选的“变化通知分组”回复：

```text
【当前倍率】
站点A：
分组1：0.001
分组2：0.002
站点B：
分组3：0.015
```

实时检测可能同时触发正常的倍率变化通知；根据站点响应速度，汇总结果可能需要等待几十秒。

在通知群发送精确指令 `查利润`，机器人会实时获取所有启用上游的今日消耗，同时查询本站 NewAPI 的今日总消耗，然后回复：

```text
【利润】
站点A：123.11
站点B：11.12
上游总和：134.23
本站消耗：200.00
利润：65.77
```

利润等于“本站消耗 - 上游总和”，所有金额保留两位小数。为避免成本漏算，只要任一启用上游查询失败，机器人就会回复失败原因而不会发送不完整的利润。上游站点需在 `upstream-ratio-watch` 中启用登录检测并配置有效凭据。

本站 NewAPI 需配置管理员或超级管理员的系统访问令牌（不是 `sk-` API 令牌）及对应用户 ID：

```dotenv
NEWAPI_BASE_URL=https://api.example.com
NEWAPI_ACCESS_TOKEN=系统访问令牌
NEWAPI_USER_ID=1
```

机器人调用本站 NewAPI 的 `/api/log/stat` 获取当天全部用户的消耗，并从 `/api/status` 自动读取 `quota_per_unit`。无法读取时使用 `NEWAPI_QUOTA_PER_UNIT`，默认值为 `500000`。

在通知群发送精确指令 `查充值`，机器人会遍历本站 NewAPI 管理员充值订单接口的全部分页，只统计上海时区当天完成且状态为 `success` 的订单，并回复实际付款字段 `money` 的总和与成功订单数：

```text
【今日充值】
今日实际付款总和：¥1234.50
今日成功订单数：18
```

充值统计复用上述本站 NewAPI 管理员凭据和 `PROFIT_TIMEZONE` 时区，不经过 `upstream-ratio-watch`。待支付、失败、过期以及非当天完成的订单不会计入结果。

通知接口只在共享 Docker 网络中暴露：

```text
POST http://qq-monitor-bot:3100/api/notify
Authorization: Bearer <NOTIFY_API_TOKEN>
```

请求中的 `group_id` 必须与 `NOTIFY_GROUP_ID` 完全一致，否则机器人返回 `403`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ONEBOT_ACCESS_TOKEN` | 空 | OneBot 访问令牌 |
| `COMMAND` | `查监控` | 精确匹配的群指令 |
| `BALANCE_COMMAND` | `查余额` | 通知群内查询全部站点余额的精确指令 |
| `BALANCE_API_URL` | `http://upstream-ratio-watch:8000/api/bot/balances` | 监控面板内部余额接口 |
| `RATIO_COMMAND` | `查倍率` | 通知群内实时检测已选分组倍率的精确指令 |
| `RATIO_API_URL` | `http://upstream-ratio-watch:8000/api/bot/ratios` | 监控面板实时倍率接口 |
| `PROFIT_COMMAND` | `查利润` | 通知群内查询今日利润的精确指令 |
| `RECHARGE_COMMAND` | `查充值` | 通知群内查询本站 NewAPI 今日成功充值总额与订单数的精确指令 |
| `USAGE_API_URL` | `http://upstream-ratio-watch:8000/api/bot/usages/today` | 监控面板实时查询上游今日消耗的接口 |
| `NEWAPI_BASE_URL` | 空 | 本站 NewAPI 地址 |
| `NEWAPI_ACCESS_TOKEN` | 空 | 本站 NewAPI 管理员/超级管理员系统访问令牌 |
| `NEWAPI_USER_ID` | 空 | 上述系统访问令牌所属的用户 ID |
| `NEWAPI_QUOTA_PER_UNIT` | `500000` | 无法自动检测时的 NewAPI 金额换算基数 |
| `PROFIT_TIMEZONE` | `Asia/Shanghai` | 本站今日消耗的日期边界时区 |
| `QUERY_GROUP_ID` | 空 | 唯一允许触发查询指令的 QQ 群号；未配置时禁用查询 |
| `NOTIFY_GROUP_ID` | 空 | 上游监控通知固定发送的 QQ 群号 |
| `NOTIFY_API_TOKEN` | 空 | HTTP 通知接口 Bearer Token；未配置时拒绝请求 |
| `NOTIFY_PORT` | `3100` | Docker 共享网络中的通知接口端口 |
| `SCREENSHOT_DELAY_MS` | `3000` | 页面打开后的等待时间 |
| `SCREENSHOT_FULL_PAGE` | `false` | 是否截取完整页面 |
| `VIEWPORT_WIDTH` | `1440` | 浏览器视口宽度 |
| `VIEWPORT_HEIGHT` | `900` | 浏览器视口高度 |

固定 URL 不取自群消息，只有指定查询群的群成员能触发，也不会让群成员指定其他页面。通知 API 只能向配置好的通知群发送消息。
