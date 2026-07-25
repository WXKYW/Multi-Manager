# API Monitor

API Monitor 是一个自托管的 API 管理、云资源管理与主机监控面板。

集中管理服务器、DNS、对象存储、PaaS、文件分享等各种分散服务。

## 功能概览

- 主机实例监控、实时指标、WebSocket 更新、终端与文件管理
- Docker、进程、网络质量、流量配额与告警
- Cloudflare、阿里云、腾讯云、Koyeb、Fly.io 等云服务管理
- OpenAI 兼容接口、模型调用记录与用量统计
- 可用性监测、公开状态页、自定义域名与首页快捷入口
- 文件中转、TOTP、备份、定时任务、通知模板与系统日志
- 还有很多待定功能>>>>>>

![image](https://image.dooo.ng/t/2026/07/23/6a61fba454686.webp)

## 快速部署

### Docker Compose

```yaml
services:
  api-monitor:
    image: iwvw/api-monitor:latest
    container_name: api-monitor
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data:/app/data
    environment:
      - APP_ENV=production
      - SECURE_COOKIES=true
      - ADMIN_PASSWORD=<CHANGE_ME>
      - JWT_SECRET=<CHANGE_ME_TO_A_LONG_RANDOM_STRING>
      - ENCRYPTION_KEY=<CHANGE_ME_TO_ANOTHER_LONG_RANDOM_STRING>
    restart: unless-stopped
```

### Docker CLI

```bash
docker run -d --name api-monitor \
  -p 127.0.0.1:3000:3000 \
  -v ./data:/app/data \
  -e APP_ENV=production \
  -e SECURE_COOKIES=true \
  -e ADMIN_PASSWORD=<CHANGE_ME> \
  -e JWT_SECRET=<CHANGE_ME_TO_A_LONG_RANDOM_STRING> \
  -e ENCRYPTION_KEY=<CHANGE_ME_TO_ANOTHER_LONG_RANDOM_STRING> \
  --restart unless-stopped \
  iwvw/api-monitor:latest
```

生产模式默认只发布到宿主机回环地址，必须通过同机 HTTPS 反向代理访问；`Secure` 会话 Cookie 不会在普通 HTTP 页面中生效。如确需直接对外发布，必须显式修改绑定地址并先配置 TLS、防火墙或 VPN。本地开发保持默认的 `APP_ENV=development`，可直接使用 `http://localhost:5173`。

## 本地开发

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run lint
npm run build
npm run backend-go:test
npm run backend-go:build
```

## 配置

可通过环境变量或 `.env` 配置。发布部署至少建议设置：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `3000` |
| `GO_HOST` | Go 服务监听地址；生产默认 `127.0.0.1`，开发默认 `0.0.0.0` |
| `PUBLISHED_HOST` | Docker Compose 宿主机发布地址，默认 `127.0.0.1` |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `DB_NAME` | SQLite 数据库文件名，默认 `data.db` |
| `ADMIN_PASSWORD` | 初始化管理员密码，仅首次初始化使用 |
| `JWT_SECRET` | 会话密钥，建议使用长随机字符串 |
| `LOG_LEVEL` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR` |
| `APP_ENV` | `development` 或 `production`；生产模式启用更严格的安全默认值 |
| `SECURE_COOKIES` | 是否仅通过 HTTPS 发送会话 Cookie；生产环境强制为 `true` |
| `ALLOW_LOCAL_SHELL_TASKS` | 是否允许后台直接执行本机 Shell；生产默认 `false` |
| `TRUSTED_PROXY_CIDRS` | 允许提供真实客户端 IP 的反向代理 IP/CIDR 列表 |
| `CORS_ALLOWED_ORIGINS` | 允许跨域访问 API 的 Origin 白名单，逗号分隔 |

## 技术栈

- 后端：Go + SQLite
- 前端：React + Vite + Tailwind CSS + Kumo UI
- Agent：Rust
- 实时通信：Engine.IO / WebSocket

## 文档

- [文档索引](./docs/README.md)
- [开发指南](./docs/开发指南.md)
- [API 接口文档](./docs/API接口文档.md)
- [安全加固与扫描计划](./docs/安全加固与扫描计划.md)
- [Kumo UI 规则](./docs/Kumo%20UI%20规则.md)

## 许可证

[MIT](./LICENSE)
