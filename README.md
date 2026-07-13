# QQ 群监控截图机器人

群成员发送精确指令 `查监控` 后，机器人打开固定页面 `https://status.yyapi.cloud/status/ai-status`、截图并发回原群。服务通过 OneBot 11 WebSocket 与 NapCatQQ 等 QQ 机器人框架通信。

## 1. 配置 OneBot

在 NapCatQQ 中启用 OneBot 11 WebSocket 服务，监听端口例如 `3001`。如果设置了访问令牌，机器人服务中也必须填写相同令牌。

## 2. 配置机器人

```bash
cd qq-monitor-bot
cp .env.example .env
nano .env
```

按 NapCat 的配置修改：

```dotenv
ONEBOT_WS_URL=ws://NapCat所在主机:3001
ONEBOT_ACCESS_TOKEN=与NapCat相同的令牌
```

如果机器人运行在 Docker 中，而 NapCat 运行在同一台 Linux 主机上，地址中的 `127.0.0.1` 应改成 `host.docker.internal`：

```dotenv
ONEBOT_WS_URL=ws://host.docker.internal:3001
```

## 3. Docker 启动

```bash
docker compose up -d --build
docker compose logs -f
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | OneBot WebSocket 地址 |
| `ONEBOT_ACCESS_TOKEN` | 空 | OneBot 访问令牌 |
| `COMMAND` | `查监控` | 精确匹配的群指令 |
| `SCREENSHOT_DELAY_MS` | `3000` | 页面打开后的等待时间 |
| `SCREENSHOT_FULL_PAGE` | `false` | 是否截取完整页面 |
| `VIEWPORT_WIDTH` | `1440` | 浏览器视口宽度 |
| `VIEWPORT_HEIGHT` | `900` | 浏览器视口高度 |

固定 URL 不取自群消息，所有群成员都能触发，但不会让群成员指定其他页面。
