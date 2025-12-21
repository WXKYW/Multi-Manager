# 使用 Global API Key 的说明

## ✅ 好消息
代码已经修改完成，**现在支持 Global API Key** 了！

## 🔑 如何获取 Global API Key

### 步骤 1: 登录 Cloudflare
访问 https://dash.cloudflare.com

### 步骤 2: 进入 API Tokens 页面
- 点击右上角头像
- 选择 **My Profile**
- 左侧菜单选择 **API Tokens**

### 步骤 3: 查看 Global API Key
- 向下滚动到 **API Keys** 部分（不是 API Tokens）
- 找到 **Global API Key**
- 点击 **View** 查看

**需要的信息：**
1. ✅ **Email** - 您的 Cloudflare 登录邮箱
2. ✅ **Global API Key** - 点击 View 后显示的密钥

## 📝 如何在应用中添加 Global API Key

### 方案 1: 编辑现有账号

1. 在 DNS 模块中找到您的账号
2. 点击 **编辑** 按钮
3. 在表单中填入：
   - **Email**: 您的 Cloudflare 邮箱
   - **API Token**: 粘贴 Global API Key

4. 点击保存

### 方案 2: 添加新账号

1. 点击 **添加账号**
2. 填写表单：
   ```
   名称: 我的 Cloudflare 账号
   Email: your-email@example.com    ← 必填
   API Token: your-global-api-key   ← 粘贴 Global API Key
   ```
3. 点击保存

## 🔄 认证方式自动切换

代码会**自动检测**应该使用哪种认证方式：

- ✅ **如果有 Email**：使用 Global API Key 认证
  ```javascript
  X-Auth-Email: your@email.com
  X-Auth-Key: global-api-key
  ```

- ✅ **如果没有 Email**：使用 API Token 认证
  ```javascript
  Authorization: Bearer api-token
  ```

## ⚡ 使用 Global API Key 的优势

1. **✅ 完整权限** - 无需配置任何权限，拥有所有功能
2. **✅ 一劳永逸** - 不会出现权限不足的错误
3. **✅ 简单配置** - 只需 Email + Key 两个参数

## ⚠️ 安全提示

Global API Key 拥有账号的完全控制权限，请：

- 🔒 **妥善保管** - 不要分享给他人
- 🔒 **定期轮换** - 建议每3-6个月更换一次
- 🔒 **限制访问** - 仅在可信的环境中使用

如果您更注重安全性，建议使用 **API Token** 配合精细的权限控制。

## 🧪 测试步骤

1. **编辑账号**添加 Email
2. **刷新页面**
3. **选择域名**
4. **点击"清缓存"按钮**
5. **查看服务器日志**，应该看到：
   ```
   使用认证方式: Global API Key
   调用 Cloudflare API 清除缓存...
   缓存已清除成功
   ```

## 📊 对比：API Token vs Global API Key

| 特性 | API Token | Global API Key |
|------|-----------|----------------|
| 权限控制 | ✅ 精细可控 | ❌ 完全权限 |
| 安全性 | ✅ 更安全 | ⚠️ 需谨慎保管 |
| 配置复杂度 | ⚠️ 需配置权限 | ✅ 零配置 |
| 权限错误 | ⚠️ 可能出现 | ✅ 不会出现 |
| 推荐场景 | 生产环境 | 开发/测试 |

## 🆘 常见问题

### Q: 我已经添加了 Email，为什么还是失败？
A: 请确保：
- Email 是正确的 Cloudflare 登录邮箱
- API Token 字段填的是 **Global API Key**（不是 API Token）
- 已刷新页面

### Q: 如何知道使用的是哪种认证方式？
A: 查看服务器日志，会显示：
```
使用认证方式: Global API Key
或
使用认证方式: API Token
```

### Q: 可以同时使用两种认证方式吗？
A: 可以！不同的账号可以使用不同的认证方式。

---

**更新时间**: 2025-12-21  
**状态**: ✅ 已完成 - 支持双认证方式
