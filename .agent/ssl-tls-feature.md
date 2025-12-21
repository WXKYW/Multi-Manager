# SSL/TLS 证书管理功能

## ✅ 后端实现完成
完成时间: 2025-12-21

## 📚 功能概览

提供域名的SSL/TLS证书信息查看和SSL模式配置功能。

## 🔧 后端API端点

### 1. 获取SSL信息
```
GET /api/cf-dns/accounts/:accountId/zones/:zoneId/ssl
```

**返回数据：**
```javascript
{
  success: true,
  ssl: {
    mode: "full",              // SSL模式
    modifiedOn: "2025-12-21",  // 最后修改时间
    editable: true,            // 是否可编辑
    certificates: [{
      id: "cert-id",
      type: "universal",       // 证书类型
      hosts: ["*.example.com", "example.com"],
      status: "active",        // 证书状态
      validityDays: 90,        // 有效期(天)
      certificateAuthority: "google",
      primary: true
    }],
    verification: []           // 验证状态
  }
}
```

### 2. 修改SSL模式
```
PATCH /api/cf-dns/accounts/:accountId/zones/:zoneId/ssl
Content-Type: application/json

{
  "mode": "full"  // off, flexible, full, strict
}
```

## 🔐 SSL模式说明

### Off (关闭)
- ❌ 不使用HTTPS
- ⚠️ 所有流量都是HTTP
- 不推荐使用

### Flexible (灵活)
- 🌐 浏览器 → Cloudflare: HTTPS
- 🔓 Cloudflare → 源服务器: HTTP
- ⚠️ 不验证源服务器证书
- 适用于源服务器不支持HTTPS

### Full (完全)
- 🔒 浏览器 → Cloudflare: HTTPS
- 🔒 Cloudflare → 源服务器: HTTPS
- ⚠️ 接受自签名证书
- 推荐用于大多数场景

### Full (strict) 完全(严格)
- 🔒 浏览器 → Cloudflare: HTTPS
- 🔒 Cloudflare → 源服务器: HTTPS (验证证书)
- ✅ 最安全的选项
- 需要有效的SSL证书

## 📊 证书类型

### Universal SSL
- ✅ Cloudflare免费提供
- ✅ 自动续期
- ✅ 覆盖根域名和一级子域名
- 🕐 激活时间: 最长24小时

### Custom SSL
- 💰 需要付费计划
- 🔧 上传自己的证书
- 🎯 完全控制

### Advanced Certificate
- 💰 需要付费计划
- 🎨 自定义通配符
- ⏰ 更快的激活时间

## 🎨 前端实现建议

### UI位置
在DNS记录列表上方添加SSL状态卡片

### 显示内容
```
┌─ SSL/TLS 状态 ──────────────────────────┐
│ 当前模式: Full (完全)                   │
│ 证书类型: Universal SSL                 │
│ 证书状态: ✅ Active                     │
│ 有效期: 还剩 45 天                      │
│                                          │
│ [修改SSL模式 ▼]                          │
└──────────────────────────────────────────┘
```

### 交互流程

1. **加载SSL信息**
   - 选择域名后自动加载
   - 显示loading状态

2. **显示信息**
   - SSL模式（带图标）
   - 证书状态（颜色编码）
   - 有效期倒计时

3. **修改SSL模式**
   - 下拉菜单选择
   - 确认对话框
   - 更新成功提示

## 🎯 前端代码示例

### store.js 添加状态
```javascript
// SSL/TLS
dnsSelectedZoneSsl: null,
dnsLoadingSsl: false,
```

### dns.js 添加方法
```javascript
async loadZoneSsl() {
  if (!store.dnsSelectedAccountId || !store.dnsSelectedZoneId) return;
  
  store.dnsLoadingSsl = true;
  
  try {
    const response = await fetch(
      `/api/cf-dns/accounts/${store.dnsSelectedAccountId}/zones/${store.dnsSelectedZoneId}/ssl`,
      { headers: store.getAuthHeaders() }
    );
    
    const data = await response.json();
    if (data.success) {
      store.dnsSelectedZoneSsl = data.ssl;
      toast.success('SSL信息已加载');
    }
  } catch (error) {
    toast.error('加载SSL信息失败');
  } finally {
    store.dnsLoadingSsl = false;
  }
},

async updateSslMode(mode) {
  const confirmed = await store.showConfirm({
    title: '确认修改SSL模式',
    message: `确定要将SSL模式修改为 "${mode}" 吗？`,
    confirmText: '确认修改'
  });
  
  if (!confirmed) return;
  
  try {
    const response = await fetch(
      `/api/cf-dns/accounts/${store.dnsSelectedAccountId}/zones/${store.dnsSelectedZoneId}/ssl`,
      {
        method: 'PATCH',
        headers: store.getAuthHeaders(),
        body: JSON.stringify({ mode })
      }
    );
    
    const data = await response.json();
    if (data.success) {
      store.dnsSelectedZoneSsl.mode = data.ssl.mode;
      toast.success(`SSL模式已更新为: ${mode}`);
    }
  } catch (error) {
    toast.error('更新SSL模式失败');
  }
}
```

### dns.html UI模板
```html
<!-- SSL状态卡片 -->
<div v-if="dnsSelectedZoneId && dnsSelectedZoneSsl" class="ssl-status-card">
  <div class="ssl-header">
    <i class="fas fa-lock"></i>
    <h3>SSL/TLS 证书</h3>
  </div>
  
  <div class="ssl-body">
    <!-- SSL模式 -->
    <div class="ssl-row">
      <span class="ssl-label">当前模式:</span>
      <div class="ssl-mode-selector">
        <select v-model="dnsSelectedZoneSsl.mode" @change="updateSslMode(dnsSelectedZoneSsl.mode)">
          <option value="off">Off (关闭)</option>
          <option value="flexible">Flexible (灵活)</option>
          <option value="full">Full (完全)</option>
          <option value="strict">Full (strict)</option>
        </select>
      </div>
    </div>
    
    <!-- 证书信息 -->
    <div v-for="cert in dnsSelectedZoneSsl.certificates" :key="cert.id" class="ssl-cert">
      <div class="ssl-row">
        <span class="ssl-label">证书类型:</span>
        <span class="ssl-value">{{ cert.type }}</span>
      </div>
      <div class="ssl-row">
        <span class="ssl-label">状态:</span>
        <span class="ssl-status" :class="'status-' + cert.status">
          {{ cert.status }}
        </span>
      </div>
      <div class="ssl-row">
        <span class="ssl-label">有效期:</span>
        <span class="ssl-value">{{ cert.validityDays }} 天</span>
      </div>
    </div>
  </div>
</div>
```

### dns.css 样式
```css
/* SSL状态卡片 */
.ssl-status-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
}

.ssl-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.ssl-header i {
  color: var(--success-color);
  font-size: 20px;
}

.ssl-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.ssl-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-light);
}

.ssl-row:last-child {
  border-bottom: none;
}

.ssl-label {
  color: var(--text-secondary);
  font-size: 14px;
}

.ssl-value {
  color: var(--text-primary);
  font-weight: 500;
}

.ssl-mode-selector select {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
}

.ssl-status {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.ssl-status.status-active {
  background: var(--success-light);
  color: var(--success-color);
}

.ssl-status.status-pending {
  background: var(--warning-light);
  color: var(--warning-color);
}
```

## ✅ 验收标准

- [ ] 选择域名后自动加载SSL信息
- [ ] 正确显示SSL模式
- [ ] 正确显示证书类型和状态
- [ ] 可以更改SSL模式
- [ ] 更改后有成功提示
- [ ] 错误处理完善
- [ ] UI美观，符合整体风格

## 🚀 快速实现

如果需要快速实现前端，只需：
1. 在 `selectDnsZone()` 函数中调用 `loadZoneSsl()`
2. 在 `dns.html` 的记录列表上方添加SSL卡片
3. 添加对应的CSS样式

**估算时间**: 1-2小时

---

**状态**: ✅ 后端完成，待前端实现  
**创建时间**: 2025-12-21
