# Analytics 仪表板功能 - 后端完成

## ✅ 后端实现完成
完成时间: 2025-12-21

## 📊 功能概览

提供域名的流量和性能统计数据可视化。

## 🔧 后端API端点

### 获取Analytics数据
```
GET /api/cf-dns/accounts/:accountId/zones/:zoneId/analytics?timeRange=24h
```

**查询参数：**
- `timeRange`: `24h`, `7d`, `30d` (默认: 24h)

**返回数据：**
```javascript
{
  success: true,
  analytics: {
    requests: 125000,      // 总请求数
    bandwidth: 5242880,    // 带宽使用（字节）
    threats: 120,          // 威胁数量
    pageViews: 98000,      // 页面浏views
    uniques: 45000,        // 独立访客
    cacheHitRate: 85,      // 缓存命中率(%)
    timeseries: [...]      // 时间序列数据
  },
  timeRange: "24h"
}
```

## 📈 数据指标说明

### 请求数 (Requests)
- 总HTTP/HTTPS请求数
- 包括缓存和未缓存的请求

### 带宽 (Bandwidth)
- 总传输字节数
- 包括出站和入站流量

### 威胁 (Threats)
- 被阻止的恶意请求数
- 包括DDoS、bot攻击等

### 页面浏览 (Page Views)
- HTML页面请求数
- 不包括静态资源

### 独立访客 (Uniques)
- 基于IP的唯一访客数
- 24小时内同一IP计为1个

### 缓存命中率 (Cache Hit Rate)
- 从缓存提供的请求百分比
- 公式: (缓存请求数 / 总请求数) × 100%

## 🎨 前端实现建议

### UI设计（紧凑版）

```
┌─ 📊 Analytics (最近24h) ──────────────────────┐
│  📊 125K请求  |  📦 5MB  |  🛡️ 120威胁  |  ⚡ 85%缓存  │
└────────────────────────────────────────────────┘
```

### 完整版UI设计

```
┌─ 📊 Analytics ──────────────────────────────┐
│  [24h] [7d] [30d]                    🔄     │
├──────────────────────────────────────────────┤
│  📊 总请求      📦 带宽        🛡️ 威胁      │
│  125,000       5.0 MB        120           │
│                                              │
│  👥 访客        📄 PV        ⚡ 缓存        │
│  45,000       98,000        85%           │
└──────────────────────────────────────────────┘
```

## 💻 前端代码示例

###store.js 添加状态
```javascript
// Analytics
dnsSelectedZoneAnalytics: null,
dnsLoadingAnalytics: false,
dnsAnalyticsTimeRange: '24h',
```

### dns.js 添加方法
```javascript
async loadZoneAnalytics(timeRange = '24h') {
  if (!store.dnsSelectedAccountId || !store.dnsSelectedZoneId) return;
  
  store.dnsLoadingAnalytics = true;
  
  try {
    const response = await fetch(
      `/api/cf-dns/accounts/${store.dnsSelectedAccountId}/zones/${store.dnsSelectedZoneId}/analytics?timeRange=${timeRange}`,
      { headers: store.getAuthHeaders() }
    );
    
    const data = await response.json();
    if (data.success) {
      store.dnsSelectedZoneAnalytics = data.analytics;
      store.dnsAnalyticsTimeRange = timeRange;
    }
  } catch (error) {
    toast.error('加载Analytics失败');
  } finally {
    store.dnsLoadingAnalytics = false;
  }
},

// 格式化数字
formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
},

// 格式化字节
formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return bytes + ' B';
}
```

### dns.html UI模板（紧凑版）
```html
<!-- Analytics 仪表板（紧凑版） -->
<div v-if="dnsSelectedZoneId && dnsSelectedZoneAnalytics" class="analytics-card">
  <div class="analytics-header">
    <div class="analytics-title">
      <i class="fas fa-chart-bar"></i>
      <span>Analytics</span>
      <span class="analytics-time-badge">{{ dnsAnalyticsTimeRange }}</span>
    </div>
    <div class="analytics-time-selector">
      <button 
        v-for="range in ['24h', '7d', '30d']" 
        :key="range"
        @click="loadZoneAnalytics(range)"
        :class="['time-btn', { active: dnsAnalyticsTimeRange === range }]">
        {{ range }}
      </button>
    </div>
    <button @click="loadZoneAnalytics(dnsAnalyticsTimeRange)" class="refresh-btn" :disabled="dnsLoadingAnalytics">
      <i class="fas fa-sync" :class="{ 'fa-spin': dnsLoadingAnalytics }"></i>
    </button>
  </div>
  
  <div class="analytics-metrics">
    <div class="metric">
      <i class="fas fa-chart-line"></i>
      <span class="metric-value">{{ formatNumber(dnsSelectedZoneAnalytics.requests) }}</span>
      <span class="metric-label">请求</span>
    </div>
    <div class="metric">
      <i class="fas fa-database"></i>
      <span class="metric-value">{{ formatBytes(dnsSelectedZoneAnalytics.bandwidth) }}</span>
      <span class="metric-label">带宽</span>
    </div>
    <div class="metric">
      <i class="fas fa-shield-alt"></i>
      <span class="metric-value">{{ formatNumber(dnsSelectedZoneAnalytics.threats) }}</span>
      <span class="metric-label">威胁</span>
    </div>
    <div class="metric">
      <i class="fas fa-bolt"></i>
      <span class="metric-value">{{ dnsSelectedZoneAnalytics.cacheHitRate }}%</span>
      <span class="metric-label">缓存</span>
    </div>
  </div>
</div>
```

### CSS样式（紧凑版）
```css
.analytics-card {
  background: linear-gradient(135deg, var(--bg-primary) 0%, var(--bg-secondary) 100%);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
}

.analytics-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.analytics-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.analytics-time-badge {
  background: var(--cf-color);
  color: white;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}

.analytics-time-selector {
  display: flex;
  gap: 4px;
}

.time-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.time-btn.active {
  background: var(--cf-color);
  color: white;
  border-color: var(--cf-color);
}

.analytics-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.metric {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}

.metric i {
  font-size: 20px;
  color: var(--cf-color);
}

.metric-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.metric-label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
}

@media (max-width: 768px) {
  .analytics-metrics {
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }
}
```

## ✅ 验收标准

- [ ] 选择域名后自动加载Analytics
- [ ] 正确显示所有指标
- [ ] 时间范围切换正常工作
- [ ] 刷新按钮正常工作
- [ ] 数字格式化美观
- [ ] 移动端响应式
- [ ] 错误处理完善

## 🚀 快速实现步骤

1. 在selectDnsZone中调用loadZoneAnalytics()
2. 添加formatNumber和formatBytes工具函数
3. 在SSL卡片下方添加Analytics卡片HTML
4. 添加CSS样式
5. 测试功能

**估算时间**: 1-2小时

---

**状态**: ✅ 后端完成，待前端实现  
**创建时间**: 2025-12-21
