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
| `QUERY_GROUP_ID` | 空 | 唯一允许触发查询指令的 QQ 群号；未配置时禁用查询 |
| `NOTIFY_GROUP_ID` | 空 | 上游监控通知固定发送的 QQ 群号 |
| `NOTIFY_API_TOKEN` | 空 | HTTP 通知接口 Bearer Token；未配置时拒绝请求 |
| `NOTIFY_PORT` | `3100` | Docker 共享网络中的通知接口端口 |
| `SCREENSHOT_DELAY_MS` | `3000` | 页面打开后的等待时间 |
| `SCREENSHOT_FULL_PAGE` | `false` | 是否截取完整页面 |
| `VIEWPORT_WIDTH` | `1440` | 浏览器视口宽度 |
| `VIEWPORT_HEIGHT` | `900` | 浏览器视口高度 |

固定 URL 不取自群消息，只有指定查询群的群成员能触发，也不会让群成员指定其他页面。通知 API 只能向配置好的通知群发送消息。
