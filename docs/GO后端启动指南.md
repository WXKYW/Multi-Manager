# Go 后端启动指南

最后更新：2026-07-07

当前默认运行架构是 Go 后端。路由清单由 `backend-go/internal/manifest/manifest.go` 管理，当前 route inventory 为 179 条 Go-owned 路由。旧 Node sidecar 资料仅作为迁移历史，不作为日常启动路径。

## 快速启动

### npm 一键开发

```bash
npm run dev
```

该命令同时启动 Go 后端和 Vite 前端。

### 只启动 Go 后端

```bash
npm run backend-go:dev
```

或：

```bash
cd backend-go
go run ./cmd/api-monitor
```

默认监听：

```text
http://localhost:3000
```

## 配置

常用环境变量：

```bash
PORT=3000
DATA_DIR=./data
DB_NAME=data.db
LOG_LEVEL=INFO
JWT_SECRET=<JWT_SECRET>
ADMIN_PASSWORD=<ADMIN_PASSWORD>
```

数据目录必须作为真实运行数据保护，不要被清理脚本或重构任务删除。

## 构建

```bash
npm run backend-go:build
```

输出：

```text
backend-go/api-monitor.exe
```

该文件是可再生成产物，允许由 `npm run clean:workspace` 删除。

## 验证

### 健康检查

```bash
curl http://localhost:3000/health
```

### 路由清单

```bash
node tools/backend-route-inventory.mjs
```

### Go 测试

```bash
npm run backend-go:test
```

### 后端 smoke

```bash
npm run backend-go:smoke
```

默认检查 `http://127.0.0.1:3000/health`。如果后端在其他地址：

```bash
API_MONITOR_BASE_URL=http://127.0.0.1:3000 npm run backend-go:smoke
```

## 功能回归清单

- 认证与 2FA。
- 用户设置与页面宽度/主题偏好。
- TOTP、Cron、Filebox、Notification、Uptime。
- Cloudflare DNS、Workers、Pages、R2、Tunnels。
- 阿里云、腾讯云、Koyeb、Fly.io。
- OpenAI-compatible、Qwen、Gemini CLI。
- Server 账号、凭据、代码片段、Agent 安装、实时指标、Docker、终端、SFTP。

真实云厂商、Agent、SSH/SFTP、Docker 和外部 AI API 仍需要真实环境 smoke。

## 故障排查

### 端口占用

Windows：

```bash
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

Linux/macOS：

```bash
lsof -ti:3000 | xargs kill -9
```

### 数据库权限或锁定

- 确认 `DATA_DIR` 指向正确数据目录。
- 确认没有多个后端实例同时写入同一数据库。
- 不要手动删除 `data/`、`backup/` 或 `backend-go/data/`。

### 前端 404

生产模式需要先构建前端：

```bash
npm run build
```

## 相关命令

```bash
npm run governance:check
npm run ui:governance
npm run audit:fast
npm run clean:check
```

完整状态见 [Go 后端迁移状态](./backend-migration-complete.md)。
