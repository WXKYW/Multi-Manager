# API Monitor Agent (Go)

基于 Go 语言重构的 API Monitor Agent，用于采集服务器指标并上报到 Dashboard。

## 特性

- 🚀 **高性能**: Go 语言编写，单二进制部署，资源占用低
- 📊 **实时监控**: CPU、内存、磁盘、网络流量实时采集
- 🔗 **Socket.IO**: 与 Dashboard 实时通信
- 🔄 **自动重连**: 断线自动重连，稳定可靠
- 🐧 **跨平台**: 支持 Linux、Windows、macOS

## 构建

```bash
# 安装依赖
go mod tidy

# 构建当前平台
go build -o agent

# 交叉编译 Linux amd64
GOOS=linux GOARCH=amd64 go build -o agent-linux-amd64

# 交叉编译 Linux arm64
GOOS=linux GOARCH=arm64 go build -o agent-linux-arm64

# 交叉编译 Windows
GOOS=windows GOARCH=amd64 go build -o agent-windows-amd64.exe
```

## 使用

```bash
# 基本用法
./agent --id <SERVER_ID> -k <AGENT_KEY> -s <SERVER_URL>

# 示例
./agent --id abc123 -k secret123 -s http://your-server:3000

# 调试模式
./agent --id abc123 -k secret123 -s http://your-server:3000 -d
```

### 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-s, --server` | Dashboard 地址 | http://localhost:3000 |
| `--id` | 主机 ID (必需) | - |
| `-k` | Agent 密钥 (必需) | - |
| `-i` | 上报间隔 (毫秒) | 1500 |
| `-d` | 调试模式 | false |

### 环境变量

| 变量 | 说明 |
|------|------|
| `API_MONITOR_SERVER` | Dashboard 地址 |
| `API_MONITOR_SERVER_ID` | 主机 ID |
| `API_MONITOR_KEY` | Agent 密钥 |

### 配置文件

创建 `config.json`:

```json
{
  "serverUrl": "http://your-server:3000",
  "serverId": "your-server-id",
  "agentKey": "your-agent-key",
  "reportInterval": 1500,
  "debug": false
}
```

## 采集指标

### 主机信息 (每 10 分钟)

- 操作系统平台和版本
- CPU 型号和核心数
- 内存总量
- 磁盘总量
- 公网 IP

### 实时状态 (每 1.5 秒)

- CPU 使用率
- 内存使用量
- 磁盘使用量
- 网络流量和速度
- 系统负载
- TCP/UDP 连接数
- 运行时长

## 依赖

- [gorilla/websocket](https://github.com/gorilla/websocket) - WebSocket 客户端
- [shirou/gopsutil](https://github.com/shirou/gopsutil) - 系统信息采集

## License

MIT
