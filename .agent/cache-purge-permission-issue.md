# Cloudflare 缓存清除功能 - 权限问题排查

## 问题描述
调用清除缓存API时遇到 **Authentication error** 错误。

## 错误信息
```
[CF-DNS] 清除缓存失败: Authentication error
POST /accounts/.../zones/.../purge 500 - 442ms
```

## 原因分析

### 1. API Token 权限不足 ⚠️
**最可能的原因**：Cloudflare API Token 缺少 **Cache Purge** 权限。

清除缓存需要的权限：
- ✅ Zone - Zone - Read
- ✅ Zone - DNS - Read/Edit
- ⚠️ **Zone - Cache Purge - Purge** ← **必需的权限！**

## 解决方案

### 方案 1: 更新现有 API Token 权限（推荐）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 点击右上角头像 → **My Profile**
3. 左侧菜单选择 **API Tokens**
4. 找到您正在使用的 Token，点击 **Edit**
5. 添加权限：
   ```
   Zone - Cache Purge - Purge
   ```
6. 保存并在应用中点击"刷新"按钮

### 方案 2: 创建新的 API Token（完整权限）

创建一个包含所有必要权限的新Token：

**权限配置：**
```
Zone Permissions:
  - Zone - Read
  - Zone Settings - Read
  - DNS - Edit
  - Cache Purge - Purge         ← 新增
  - Analytics - Read             ← 可选，用于Analytics功能
  - Workers Routes - Edit        ← 已有
  - Workers Scripts - Edit       ← 已有

Account Permissions:
  - Workers Scripts - Edit
  - Workers KV Storage - Edit
  - Pages - Edit
```

**Zone Resources:**
- Include → All zones
  或
- Include → Specific zone → 选择您的域名

**创建步骤：**
1. Cloudflare Dashboard → My Profile → API Tokens
2. 点击 **Create Token**
3. 选择 **Custom token**
4. 按上述配置设置权限
5. 创建后复制Token
6. 在应用中更新账号的API Token

### 方案 3: 使用 Global API Key（不推荐）

如果您使用的是 Global API Key，它应该有所有权限。但出于安全考虑，不建议使用。

## 验证权限

测试Token权限：
```bash
curl -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

## 临时workaround

如果暂时无法更新Token权限，可以：
1. 暂时隐藏"清缓存"按钮
2. 使用Cloudflare Dashboard手动清除缓存
3. 待Token权限更新后再使用此功能

## 其他可能的原因

### 2. Zone ID 错误
- 确认 Zone ID 是正确的
- 检查日志中的 Zone ID 是否与实际域名匹配

### 3. API Token 过期
- 检查 Token 是否有过期时间
- 在 Cloudflare Dashboard 中验证 Token 状态

### 4. 网络问题
- 确认服务器可以访问 api.cloudflare.com
- 检查防火墙设置

## 调试步骤

1. **查看详细日志**
   - 服务器控制台会显示详细的API调用信息
   - 查找 `[CF-API] 清除缓存请求` 日志

2. **验证Token**
   - 在 DNS 模块的账号管理中点击"验证"按钮
   - 检查Token是否有效

3. **测试其他功能**
   - 尝试添加/编辑DNS记录
   - 如果其他功能正常，则确认是权限问题

## 实施后的测试

Token权限更新后：
1. 刷新页面
2. 选择一个测试域名
3. 点击"清缓存"按钮
4. 应该看到成功提示："✅ 缓存已清除！域名: xxx.com"

## 需要帮助？

如果问题仍然存在：
1. 检查服务器日志中的完整错误信息
2. 确认Token权限配置截图
3. 提供Zone ID和账号ID（脱敏处理）

---

**创建时间**: 2025-12-21  
**状态**: 待解决 - 需要更新API Token权限
