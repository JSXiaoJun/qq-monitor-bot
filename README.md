# QQ 群监控截图机器人

群成员发送精确指令 `查监控` 后，机器人打开固定页面 `https://status.yyapi.cloud/status/ai-status`、截图并发回原群。服务通过 OneBot 11 WebSocket 与 NapCatQQ 等 QQ 机器人框架通信。

## 1. Linux Docker 部署

项目的 Compose 同时运行 NapCatQQ 和截图机器人。NapCat 的 OneBot 端口只在 Docker 私有网络内使用，不占用宿主机端口。

```bash
git clone https://github.com/JSXiaoJun/qq-monitor-bot.git
cd qq-monitor-bot
cp .env.example .env
docker compose up -d --build
docker compose logs -f napcat
```

NapCat WebUI 只监听服务器本机的 `6099` 端口。在自己的电脑上建立 SSH 隧道：

```bash
ssh -L 6099:127.0.0.1:6099 root@服务器IP
```

然后浏览器打开 `http://127.0.0.1:6099/webui`。默认登录 Token 为 `napcat`，登录后应立即修改。

## 2. 登录 QQ 并配置 OneBot

1. 在 NapCat WebUI 中扫码登录 QQ 小号。
2. 新建 OneBot 11 WebSocket 服务器，监听地址设为 `0.0.0.0`，端口设为 `3001`。
3. 如果设置 Access Token，把相同值写入项目 `.env` 的 `ONEBOT_ACCESS_TOKEN`。
4. 保存并重启 NapCat，然后查看机器人日志。

```bash
docker compose restart napcat monitor-bot
docker compose logs -f monitor-bot
```

日志显示 `已连接 OneBot: ws://napcat:3001` 后，在 QQ 群发送精确指令 `查监控`。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ONEBOT_ACCESS_TOKEN` | 空 | OneBot 访问令牌 |
| `COMMAND` | `查监控` | 精确匹配的群指令 |
| `SCREENSHOT_DELAY_MS` | `3000` | 页面打开后的等待时间 |
| `SCREENSHOT_FULL_PAGE` | `false` | 是否截取完整页面 |
| `VIEWPORT_WIDTH` | `1440` | 浏览器视口宽度 |
| `VIEWPORT_HEIGHT` | `900` | 浏览器视口高度 |

固定 URL 不取自群消息，所有群成员都能触发，但不会让群成员指定其他页面。
