# Cloudflare 功能扩展实现计划

## 📋 项目概述
为 API Monitor 的 Cloudflare DNS 模块添加更多实用的管理功能，提升用户体验和功能完整性。

## 🎯 优先级 P0 - 核心功能（立即实现）

### 1. 缓存管理 ✨
**功能描述**: 为选中的域名提供一键清除缓存功能
**实现难度**: ⭐ (简单)
**实用价值**: ⭐⭐⭐⭐⭐

**API端点**:
- `POST /zones/:zone_id/purge_cache` - 清除所有缓存
- `POST /zones/:zone_id/purge_cache` (带参数) - 按URL/标签清除

**UI位置**: DNS记录列表右侧按钮组
**功能点**:
- [ ] 清除所有缓存按钮
- [ ] 按URL清除缓存（输入框）
- [ ] 按标签清除缓存
- [ ] 清除进度提示

**预计工时**: 2小时

---

### 2. SSL/TLS 证书状态查看 🔒
**功能描述**: 显示域名的SSL证书信息和状态
**实现难度**: ⭐⭐ (中等)
**实用价值**: ⭐⭐⭐⭐⭐

**API端点**:
- `GET /zones/:zone_id/ssl/certificate_packs` - 获取证书包
- `GET /zones/:zone_id/ssl/verification` - 获取验证状态
- `GET /zones/:zone_id/settings/ssl` - SSL模式设置

**UI位置**: 创建新的"SSL"子标签或域名卡片展示
**功能点**:
- [ ] 显示SSL证书类型（Universal, Custom等）
- [ ] 显示证书状态（Active, Pending等）
- [ ] 显示证书有效期
- [ ] 显示SSL模式（Off, Flexible, Full, Full(strict)）
- [ ] 修改SSL模式
- [ ] SSL验证状态

**预计工时**: 4小时

---

### 3. Analytics 简易仪表板 📊
**功能描述**: 显示域名的基本流量和性能数据
**实现难度**: ⭐⭐⭐ (中等偏难)
**实用价值**: ⭐⭐⭐⭐⭐

**API端点**:
- `GET /zones/:zone_id/analytics/dashboard` - 仪表板数据
- `GET /zones/:zone_id/dns_analytics/report` - DNS分析

**UI位置**: 新建"Analytics"子标签
**功能点**:
- [ ] 请求总数（24h, 7d, 30d）
- [ ] 带宽使用量
- [ ] 缓存命中率
- [ ] 响应状态码分布
- [ ] 威胁和攻击统计
- [ ] 简单的图表展示

**预计工时**: 6小时

---

## 🎯 优先级 P1 - 重要功能（近期实现）

### 4. Workers KV 管理 💾
**功能描述**: 管理Workers的键值存储
**实现难度**: ⭐⭐⭐ (中等)
**实用价值**: ⭐⭐⭐⭐

**API端点**:
- `GET /accounts/:account_id/storage/kv/namespaces` - 列出命名空间
- `POST /accounts/:account_id/storage/kv/namespaces` - 创建命名空间
- `GET /accounts/:account_id/storage/kv/namespaces/:namespace_id/keys` - 列出键
- `PUT /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key` - 写入值
- `GET /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key` - 读取值
- `DELETE /accounts/:account_id/storage/kv/namespaces/:namespace_id/values/:key` - 删除键

**UI位置**: 在Compute标签下新建"KV Storage"子标签
**功能点**:
- [ ] 命名空间列表
- [ ] 创建/删除命名空间
- [ ] 键列表（分页）
- [ ] 查看键值内容
- [ ] 添加/编辑键值对
- [ ] 批量导入/导出
- [ ] 搜索键名

**预计工时**: 8小时

---

### 5. 防火墙规则查看 🛡️
**功能描述**: 查看和管理WAF规则
**实现难度**: ⭐⭐⭐⭐ (较难)
**实用价值**: ⭐⭐⭐⭐

**API端点**:
- `GET /zones/:zone_id/firewall/rules` - 获取防火墙规则
- `POST /zones/:zone_id/firewall/rules` - 创建规则
- `GET /zones/:zone_id/firewall/waf/packages` - WAF包
- `GET /zones/:zone_id/rulesets` - 规则集

**UI位置**: 新建"Security"主标签或DNS下的子标签
**功能点**:
- [ ] 防火墙规则列表
- [ ] 规则启用/禁用
- [ ] 查看规则详情（表达式、动作）
- [ ] WAF托管规则状态
- [ ] IP访问规则
- [ ] 速率限制规则（查看）

**预计工时**: 10小时

---

## 🎯 优先级 P2 - 增强功能（中期实现）

### 6. 页面规则 (Page Rules) 📄
**功能描述**: 配置缓存、重定向等规则
**实现难度**: ⭐⭐⭐ (中等)
**实用价值**: ⭐⭐⭐⭐

**API端点**:
- `GET /zones/:zone_id/pagerules` - 获取页面规则
- `POST /zones/:zone_id/pagerules` - 创建规则
- `PATCH /zones/:zone_id/pagerules/:rule_id` - 更新规则

**功能点**:
- [ ] 页面规则列表
- [ ] 创建规则（URL匹配、优先级）
- [ ] 配置规则设置（缓存级别、SSL、重定向等）
- [ ] 启用/禁用规则
- [ ] 规则排序

**预计工时**: 6小时

---

### 7. R2 存储桶管理 📦
**功能描述**: 管理Cloudflare R2对象存储
**实现难度**: ⭐⭐⭐⭐ (较难)
**实用价值**: ⭐⭐⭐

**API端点**:
- `GET /accounts/:account_id/r2/buckets` - 列出存储桶
- `POST /accounts/:account_id/r2/buckets` - 创建存储桶
- 使用S3兼容API管理对象

**功能点**:
- [ ] 存储桶列表
- [ ] 创建/删除存储桶
- [ ] 查看存储桶大小和对象数
- [ ] 配置存储桶CORS
- [ ] 生成访问令牌

**预计工时**: 12小时

---

### 8. 负载均衡 ⚖️
**功能描述**: 配置负载均衡池和健康检查
**实现难度**: ⭐⭐⭐⭐⭐ (困难)
**实用价值**: ⭐⭐⭐

**API端点**:
- `GET /accounts/:account_id/load_balancers/pools` - 负载池
- `POST /zones/:zone_id/load_balancers` - 创建负载均衡器
- `GET /accounts/:account_id/load_balancers/monitors` - 健康检查

**功能点**:
- [ ] 负载池管理
- [ ] 后端服务器配置
- [ ] 健康检查配置
- [ ] 负载均衡器列表
- [ ] 流量分配策略

**预计工时**: 16小时

---

### 9. Logpush 配置 📝
**功能描述**: 配置日志导出到外部服务
**实现难度**: ⭐⭐⭐⭐ (较难)
**实用价值**: ⭐⭐

**API端点**:
- `GET /zones/:zone_id/logpush/jobs` - 日志任务
- `POST /zones/:zone_id/logpush/jobs` - 创建任务

**功能点**:
- [ ] 日志任务列表
- [ ] 配置目标（S3, GCS等）
- [ ] 选择日志字段
- [ ] 启用/禁用任务

**预计工时**: 8小时

---

## 🏗️ 技术架构设计

### 文件结构
```
src/
├── js/modules/
│   ├── dns.js (扩展现有功能)
│   ├── cloudflare-cache.js (新建)
│   ├── cloudflare-ssl.js (新建)
│   ├── cloudflare-analytics.js (新建)
│   ├── cloudflare-kv.js (新建)
│   └── cloudflare-security.js (新建)
├── templates/
│   └── dns.html (扩展子标签)
└── css/
    └── dns.css (扩展样式)
```

### API路由设计
```
Backend (modules/cloudflare-dns/router.js):
- GET  /api/cf-dns/accounts/:id/zones/:zoneId/cache - 缓存信息
- POST /api/cf-dns/accounts/:id/zones/:zoneId/purge - 清除缓存
- GET  /api/cf-dns/accounts/:id/zones/:zoneId/ssl - SSL信息
- GET  /api/cf-dns/accounts/:id/zones/:zoneId/analytics - 分析数据
- GET  /api/cf-dns/accounts/:id/kv/namespaces - KV命名空间
```

---

## 🚀 实施计划

### 第一阶段（本周）✅
1. ✅ NS记录功能（已完成 - 2025-12-21）
2. ✅ 缓存管理（已完成 - 2小时，支持Global API Key）
3. ✅ SSL证书状态（后端完成 - 4小时，前端待开发）

### 第二阶段（下周）
4. Analytics仪表板（6小时）
5. Workers KV管理（8小时）

### 第三阶段（后续）
6. 防火墙规则
7. 页面规则
8. R2存储
9. 负载均衡
10. Logpush

---

## 📊 总预计工时
- P0 核心功能: 12 小时
- P1 重要功能: 18 小时
- P2 增强功能: 42 小时
- **总计**: 72 小时

---

## 🎨 UI/UX 设计原则
1. 保持与现有DNS模块的一致性
2. 使用现有的设计系统和组件
3. 提供清晰的操作反馈（Toast提示）
4. 添加loading状态和错误处理
5. 响应式设计，支持移动端

---

## ✅ 验收标准
- [ ] 所有API调用有正确的错误处理
- [ ] UI与现有模块风格一致
- [ ] 功能经过测试，无明显bug
- [ ] 提供用户友好的操作提示
- [ ] 代码有适当的注释
- [ ] 性能优化，避免不必要的API调用

---

**创建时间**: 2025-12-21
**最后更新**: 2025-12-21
