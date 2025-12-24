/**
 * Agent 服务 - 处理来自被监控服务器的 Agent 推送数据
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { serverStorage } = require('./storage');

class AgentService {
    constructor() {
        // 全局统一 Agent 密钥
        this.globalAgentKey = null;
        // 密钥存储路径
        this.keyFilePath = path.join(__dirname, '../../data/agent-key.txt');
        // 存储最新的 agent 指标
        this.agentMetrics = new Map();
        // 存储 agent 连接状态
        this.agentStatus = new Map();

        // 初始化加载或生成全局密钥
        this.loadOrGenerateGlobalKey();
    }

    /**
     * 加载或生成全局 Agent 密钥
     */
    loadOrGenerateGlobalKey() {
        try {
            // 确保 data 目录存在
            const dataDir = path.dirname(this.keyFilePath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }

            if (fs.existsSync(this.keyFilePath)) {
                this.globalAgentKey = fs.readFileSync(this.keyFilePath, 'utf8').trim();
                console.log('[AgentService] 已加载全局 Agent 密钥');
            } else {
                this.globalAgentKey = crypto.randomBytes(16).toString('hex');
                fs.writeFileSync(this.keyFilePath, this.globalAgentKey);
                console.log('[AgentService] 已生成新的全局 Agent 密钥');
            }
        } catch (error) {
            console.error('[AgentService] 密钥管理失败:', error.message);
            // 降级为内存密钥
            this.globalAgentKey = crypto.randomBytes(16).toString('hex');
        }
    }

    /**
     * 获取全局 Agent 密钥
     */
    getAgentKey(serverId) {
        // 忽略 serverId，返回全局统一密钥
        return this.globalAgentKey;
    }

    /**
     * 重新生成全局密钥
     */
    regenerateGlobalKey() {
        this.globalAgentKey = crypto.randomBytes(16).toString('hex');
        try {
            fs.writeFileSync(this.keyFilePath, this.globalAgentKey);
        } catch (e) {
            console.error('[AgentService] 保存密钥失败:', e.message);
        }
        return this.globalAgentKey;
    }

    /**
     * 验证 Agent 请求（使用全局密钥）
     */
    verifyAgent(serverId, providedKey) {
        // 验证全局密钥
        return providedKey === this.globalAgentKey;
    }

    /**
     * 处理 Agent 推送的指标数据
     */
    processMetrics(serverId, metrics) {
        const timestamp = Date.now();

        // 解析 CPU
        const cpuUsage = parseFloat(metrics.cpu) || 0;

        // 解析内存 (格式: "1024/2048" 或 "1024/2048MB")
        let memUsed = 0, memTotal = 0, memUsage = 0;
        if (metrics.mem) {
            const memMatch = metrics.mem.match(/(\d+)\/(\d+)/);
            if (memMatch) {
                memUsed = parseInt(memMatch[1]);
                memTotal = parseInt(memMatch[2]);
                memUsage = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
            }
        }

        // 解析磁盘 (格式: "38G/40G (95%)")
        let diskUsed = '', diskTotal = '', diskUsage = '';
        if (metrics.disk) {
            const diskMatch = metrics.disk.match(/([^\/]+)\/([^\s]+)\s*\(?([\d.]+%?)?\)?/);
            if (diskMatch) {
                diskUsed = diskMatch[1];
                diskTotal = diskMatch[2];
                diskUsage = diskMatch[3] || '';
            }
        }

        // 解析网络速度
        const rxSpeed = metrics.rx_speed || '0 B/s';
        const txSpeed = metrics.tx_speed || '0 B/s';
        const rxTotal = metrics.rx_total || '0 B';
        const txTotal = metrics.tx_total || '0 B';
        const connections = parseInt(metrics.connections) || 0;

        // Docker 信息
        const dockerInstalled = metrics.docker_installed === true || metrics.docker_installed === 'true' || parseInt(metrics.docker_installed) === 1;
        const dockerRunning = parseInt(metrics.docker_running) || 0;
        const dockerStopped = parseInt(metrics.docker_stopped) || 0;

        const processedMetrics = {
            timestamp,
            cpu: cpuUsage,
            cpu_usage: `${cpuUsage}%`,
            mem: `${memUsed}/${memTotal}MB`,
            mem_usage: `${memUsed}/${memTotal}MB`,
            disk: metrics.disk,
            disk_used: diskUsed,
            disk_total: diskTotal,
            disk_usage: metrics.disk,
            load: metrics.load || '0 0 0',
            cores: parseInt(metrics.cores) || 1,
            network: {
                rx_speed: rxSpeed,
                tx_speed: txSpeed,
                rx_total: rxTotal,
                tx_total: txTotal,
                connections: connections
            },
            docker: {
                installed: dockerInstalled,
                running: dockerRunning,
                stopped: dockerStopped,
                containers: Array.isArray(metrics.containers) ? metrics.containers : []
            }
        };

        // logger.debug(`[AgentService] 处理服务器 ${serverId} 的指标: CPU=${processedMetrics.cpu_usage}, MEM=${processedMetrics.mem_usage}, NET=${rxSpeed}/${txSpeed}, DOCKER=${dockerInstalled ? 'Installed' : 'None'}`);
        console.log(`[AgentService] Broadcast: ${serverId} -> CPU: ${processedMetrics.cpu_usage}, MEM: ${processedMetrics.mem_usage}, RX: ${rxSpeed}, DOCKER: ${dockerInstalled ? (metrics.containers?.length || 0) + ' containers' : 'No'}`);

        // 存储指标
        this.agentMetrics.set(serverId, processedMetrics);

        // 更新 agent 状态
        this.agentStatus.set(serverId, {
            lastSeen: timestamp,
            connected: true,
            version: metrics.agent_version || 'unknown'
        });

        // 指标已存储到内存缓存中，前端通过 API 轮询获取

        return processedMetrics;
    }

    /**
     * 获取 Agent 指标
     */
    getMetrics(serverId) {
        return this.agentMetrics.get(serverId);
    }

    /**
     * 获取 Agent 状态
     */
    getStatus(serverId) {
        const status = this.agentStatus.get(serverId);
        if (!status) {
            return { connected: false, lastSeen: null };
        }

        // 如果超过 10 秒没有收到数据，认为离线
        const isOnline = Date.now() - status.lastSeen < 10000;
        return {
            ...status,
            connected: isOnline
        };
    }

    /**
     * 生成 Agent 安装脚本
     */
    generateInstallScript(serverId, serverUrl) {
        const agentKey = this.getAgentKey(serverId);
        const server = serverStorage.getById(serverId);
        const serverName = server?.name || serverId;

        return `#!/bin/bash
# API Monitor Agent 安装脚本
# 服务器: ${serverName}
# 生成时间: ${new Date().toISOString()}

set -e

AGENT_DIR="/opt/api-monitor-agent"
SERVICE_NAME="api-monitor-agent"

# 创建目录
mkdir -p "$AGENT_DIR"

# 写入配置
cat > "$AGENT_DIR/config.env" << 'EOF'
API_URL="${serverUrl}/api/server/agent/push"
SERVER_ID="${serverId}"
AGENT_KEY="${agentKey}"
INTERVAL=2
EOF

# 写入 Agent 脚本
cat > "$AGENT_DIR/agent.sh" << 'AGENT_SCRIPT'
#!/bin/bash
source /opt/api-monitor-agent/config.env

get_net_interface() {
    ip route | awk '/default/ {print $5; exit}'
}

get_net_bytes() {
    local iface=$1
    local rx=$(cat /sys/class/net/$iface/statistics/rx_bytes 2>/dev/null || echo 0)
    local tx=$(cat /sys/class/net/$iface/statistics/tx_bytes 2>/dev/null || echo 0)
    echo "$rx $tx"
}

format_bytes() {
    local bytes=$1
    if [ $bytes -ge 1073741824 ]; then
        echo "$(awk "BEGIN {printf \\"%.2f\\", $bytes/1073741824}") GB"
    elif [ $bytes -ge 1048576 ]; then
        echo "$(awk "BEGIN {printf \\"%.2f\\", $bytes/1048576}") MB"
    elif [ $bytes -ge 1024 ]; then
        echo "$(awk "BEGIN {printf \\"%.2f\\", $bytes/1024}") KB"
    else
        echo "$bytes B"
    fi
}

format_speed() {
    local bps=$1
    if [ $bps -ge 1048576 ]; then
        echo "$(awk "BEGIN {printf \\"%.2f\\", $bps/1048576}") MB/s"
    elif [ $bps -ge 1024 ]; then
        echo "$(awk "BEGIN {printf \\"%.2f\\", $bps/1024}") KB/s"
    else
        echo "$bps B/s"
    fi
}

IF=$(get_net_interface)
read P_RX P_TX <<< $(get_net_bytes $IF)
P_TIME=$(date +%s%3N)

while true; do
    sleep $INTERVAL
    
    # CPU
    CPU=$(grep 'cpu ' /proc/stat | awk '{u=($2+$4)*100/($2+$4+$5)} END {printf "%.1f", u}')
    
    # Memory
    MEM=$(free -m | awk 'NR==2{printf "%d/%d", $3, $2}')
    
    # Disk
    DISK=$(df -h / | awk 'NR==2{printf "%s/%s (%s)", $3, $2, $5}')
    
    # Load
    LOAD=$(cat /proc/loadavg | awk '{print $1,$2,$3}')
    
    # Cores
    CORES=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
    
    # Network
    read C_RX C_TX <<< $(get_net_bytes $IF)
    C_TIME=$(date +%s%3N)
    
    DT=$((C_TIME - P_TIME))
    if [ $DT -gt 0 ]; then
        RX_SPEED=$(( (C_RX - P_RX) * 1000 / DT ))
        TX_SPEED=$(( (C_TX - P_TX) * 1000 / DT ))
    else
        RX_SPEED=0
        TX_SPEED=0
    fi
    
    P_RX=$C_RX; P_TX=$C_TX; P_TIME=$C_TIME
    
    RX_S=$(format_speed $RX_SPEED)
    TX_S=$(format_speed $TX_SPEED)
    RX_T=$(format_bytes $C_RX)
    TX_T=$(format_bytes $C_TX)
    
    # Connections
    CONNS=$(ss -ant 2>/dev/null | grep -c ESTAB || echo 0)
    
    # Docker
    if command -v docker &>/dev/null; then
        DOCKER_INSTALLED=true
        DOCKER_RUNNING=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
        DOCKER_TOTAL=$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')
        DOCKER_STOPPED=$((DOCKER_TOTAL - DOCKER_RUNNING))
    else
        DOCKER_INSTALLED=false
        DOCKER_RUNNING=0
        DOCKER_STOPPED=0
    fi
    
    # 推送数据
    curl -s -X POST "$API_URL" \\
        -H "Content-Type: application/json" \\
        -H "X-Server-ID: $SERVER_ID" \\
        -H "X-Agent-Key: $AGENT_KEY" \\
        -d "{
            \\"cpu\\": \\"$CPU\\",
            \\"mem\\": \\"$MEM\\",
            \\"disk\\": \\"$DISK\\",
            \\"load\\": \\"$LOAD\\",
            \\"cores\\": $CORES,
            \\"rx_speed\\": \\"$RX_S\\",
            \\"tx_speed\\": \\"$TX_S\\",
            \\"rx_total\\": \\"$RX_T\\",
            \\"tx_total\\": \\"$TX_T\\",
            \\"connections\\": $CONNS,
            \\"docker_installed\\": $DOCKER_INSTALLED,
            \\"docker_running\\": $DOCKER_RUNNING,
            \\"docker_stopped\\": $DOCKER_STOPPED,
            \\"agent_version\\": \\"1.0.0\\"
        }" >/dev/null 2>&1 || true
done
AGENT_SCRIPT

chmod +x "$AGENT_DIR/agent.sh"

# 创建 systemd 服务
cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
[Unit]
Description=API Monitor Agent
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash $AGENT_DIR/agent.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
systemctl daemon-reload
systemctl enable $SERVICE_NAME
systemctl restart $SERVICE_NAME

echo "✅ API Monitor Agent 安装成功！"
echo "   状态: systemctl status $SERVICE_NAME"
echo "   日志: journalctl -u $SERVICE_NAME -f"
`;
    }

    /**
     * 生成卸载脚本
     */
    generateUninstallScript() {
        return `#!/bin/bash
# API Monitor Agent 卸载脚本

SERVICE_NAME="api-monitor-agent"
AGENT_DIR="/opt/api-monitor-agent"

systemctl stop $SERVICE_NAME 2>/dev/null || true
systemctl disable $SERVICE_NAME 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE_NAME.service
systemctl daemon-reload
rm -rf "$AGENT_DIR"

echo "✅ API Monitor Agent 已卸载"
`;
    }
}

module.exports = new AgentService();
