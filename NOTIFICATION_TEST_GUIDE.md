# 通知系统测试指南

## ✅ 已完成的集成

### 1. Uptime 监控告警
- ✅ 服务宕机检测 (事件类型: `uptime` / `down`)
- ✅ 服务恢复通知 (事件类型: `uptime` / `up`)
- 文件: [modules/uptime-api/monitor-service.js](modules/uptime-api/monitor-service.js:149-177)

### 2. 主机监控告警
- ✅ 主机离线告警 (事件类型: `server` / `offline`)
- ✅ CPU 使用率超阈值 (事件类型: `server` / `cpu_high`, 阈值: 80%)
- ✅ 内存使用率超阈值 (事件类型: `server` / `memory_high`, 阈值: 85%)
- ✅ 磁盘使用率超阈值 (事件类型: `server` / `disk_high`, 阈值: 90%)
- 文件: [modules/server-api/agent-service.js](modules/server-api/agent-service.js:644-1119)

---

## 🧪 快速测试步骤

### 步骤 1: 创建通知渠道

#### Email 渠道示例

```bash
curl -X POST http://localhost:3000/api/notification/channels \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d '{
    "name": "默认邮箱",
    "type": "email",
    "enabled": true,
    "config": {
      "host": "smtp.gmail.com",
      "port": 587,
      "secure": false,
      "auth": {
        "user": "your@gmail.com",
        "pass": "your_app_password"
      },
      "to": "recipient@example.com"
    }
  }'
```

#### Telegram 渠道示例

```bash
curl -X POST http://localhost:3000/api/notification/channels \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d '{
    "name": "Telegram 通知",
    "type": "telegram",
    "enabled": true,
    "config": {
      "bot_token": "your_bot_token",
      "chat_id": "your_chat_id"
    }
  }'
```

**获取 Telegram Bot Token 和 Chat ID**:
1. 与 [@BotFather](https://t.me/BotFather) 对话创建机器人,获取 token
2. 发送消息给你的机器人
3. 访问 `https://api.telegram.org/bot<token>/getUpdates` 查看 chat_id

---

### 步骤 2: 创建告警规则

#### Uptime 宕机告警规则

```bash
# 先获取渠道 ID
CHANNEL_ID="从步骤1响应中获取的ID"

curl -X POST http://localhost:3000/api/notification/rules \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d "{
    \"name\": \"Uptime宕机告警\",
    \"source_module\": \"uptime\",
    \"event_type\": \"down\",
    \"severity\": \"critical\",
    \"channels\": [\"$CHANNEL_ID\"],
    \"suppression\": {
      \"repeat_count\": 2,
      \"silence_minutes\": 30
    },
    \"enabled\": true
  }"
```

#### Uptime 恢复告警规则

```bash
curl -X POST http://localhost:3000/api/notification/rules \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d "{
    \"name\": \"Uptime恢复通知\",
    \"source_module\": \"uptime\",
    \"event_type\": \"up\",
    \"severity\": \"info\",
    \"channels\": [\"$CHANNEL_ID\"],
    \"suppression\": {
      \"repeat_count\": 1,
      \"silence_minutes\": 0
    },
    \"enabled\": true
  }"
```

#### 主机离线告警规则

```bash
curl -X POST http://localhost:3000/api/notification/rules \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d "{
    \"name\": \"主机离线告警\",
    \"source_module\": \"server\",
    \"event_type\": \"offline\",
    \"severity\": \"critical\",
    \"channels\": [\"$CHANNEL_ID\"],
    \"suppression\": {
      \"repeat_count\": 1,
      \"silence_minutes\": 60
    },
    \"enabled\": true
  }"
```

#### CPU 高负载告警规则

```bash
curl -X POST http://localhost:3000/api/notification/rules \
  -H "Content-Type: application/json" \
  -H "Cookie: connect.sid=your_session_cookie" \
  -d "{
    \"name\": \"CPU高负载告警\",
    \"source_module\": \"server\",
    \"event_type\": \"cpu_high\",
    \"severity\": \"warning\",
    \"channels\": [\"$CHANNEL_ID\"],
    \"suppression\": {
      \"repeat_count\": 3,
      \"silence_minutes\": 15
    },
    \"enabled\": true
  }"
```

---

### 步骤 3: 测试通知发送

#### 手动触发测试

```bash
curl -X POST http://localhost:3000/api/notification/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "source_module": "uptime",
    "event_type": "down",
    "data": {
      "monitorId": "test-monitor",
      "monitorName": "测试监控",
      "url": "https://example.com",
      "error": "Connection timeout",
      "type": "http"
    }
  }'
```

#### 测试渠道

```bash
curl -X POST http://localhost:3000/api/notification/channels/$CHANNEL_ID/test \
  -H "Cookie: connect.sid=your_session_cookie"
```

---

### 步骤 4: 验证集成

#### 测试 Uptime 告警
1. 创建一个 Uptime 监控项,监控一个不存在的域名 (如 `http://test-nonexistent-domain.local`)
2. 等待监控检测到宕机 (根据间隔时间,默认60秒)
3. 检查是否收到宕机通知
4. 修改监控目标为可用地址 (如 `https://www.baidu.com`)
5. 等待检测到恢复
6. 检查是否收到恢复通知

#### 测试主机离线告警
1. 确保有主机在线
2. 停止主机上的 Agent 进程
3. 等待心跳超时 (30秒)
4. 检查是否收到离线通知
5. 重启 Agent
6. 检查主机状态

#### 测试资源告警
1. 创建高负载场景 (如运行 stress 命令)
2. 等待指标上报
3. 检查是否收到资源告警

```bash
# 在测试主机上运行
stress --cpu 4 --timeout 60s  # CPU 压力测试
```

---

## 📊 查看通知历史

```bash
curl http://localhost:3000/api/notification/history \
  -H "Cookie: connect.sid=your_session_cookie"
```

---

## 🔧 常见问题

### 1. Gmail SMTP 配置
- 需要使用应用专用密码: https://myaccount.google.com/apppasswords
- 启用两步验证后才能生成应用密码
- 端口: 587 (TLS) 或 465 (SSL)

### 2. Telegram Bot 配置
1. 与 [@BotFather](https://t.me/BotFather) 对话:
   - `/newbot` - 创建新机器人
   - 设置名称和用户名
   - 获取 token: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
2. 获取 chat_id:
   - 发送消息给机器人
   - 访问: `https://api.telegram.org/bot<token>/getUpdates`
   - 找到 `"chat":{"id":123456789}`

### 3. 调试模式
启动服务时设置环境变量:
```bash
DEBUG=notification npm start
```

---

## 📝 默认告警阈值

| 资源类型 | 阈值 | 检查间隔 |
|---------|------|---------|
| Uptime 宕机 | 连续失败 2 次 | 监控间隔 |
| Uptime 恢复 | 立即通知 | 监控间隔 |
| 主机离线 | 30秒无心跳 | 30秒 |
| CPU 使用率 | 80% | 指标上报间隔 |
| 内存使用率 | 85% | 指标上报间隔 |
| 磁盘使用率 | 90% | 指标上报间隔 |

---

## 🎯 通知级别

- **critical** (🚨) - 严重告警,需要立即处理
  - Uptime 宕机
  - 主机离线

- **warning** (⚠️) - 警告,需要关注
  - CPU/内存/磁盘高使用率

- **info** (ℹ️) - 信息通知
  - Uptime 恢复
  - 服务重启

---

## 📧 邮件模板示例

通知发送的邮件包含以下信息:
- 告警级别图标
- 监控项/主机名称
- 详细错误信息
- 时间戳
- 响应时间 (如适用)

示例:
```
🚨 [CRITICAL] Uptime宕机告警

📊 监控项: 测试监控
🔗 URL: https://example.com
❌ 错误: Connection timeout

时间: 2026-01-07 10:30:45
```

---

## ✅ 测试清单

- [ ] 创建 Email 渠道成功
- [ ] 创建 Telegram 渠道成功
- [ ] 测试渠道发送成功
- [ ] 创建 Uptime 宕机规则
- [ ] 创建 Uptime 恢复规则
- [ ] 创建主机离线规则
- [ ] 创建资源告警规则
- [ ] 手动触发测试成功
- [ ] Uptime 宕机通知正常
- [ ] Uptime 恢复通知正常
- [ ] 主机离线通知正常
- [ ] CPU 高负载通知正常
- [ ] 查看通知历史正常
