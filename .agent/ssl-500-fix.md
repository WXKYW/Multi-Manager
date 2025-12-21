# SSL功能500错误 - 快速修复指南

## 🔍 问题诊断

**错误信息:**
```
GET /api/cf-dns/accounts/.../zones/.../ssl 500 (Internal Server Error)
```

## 💡 最可能的原因

**服务器未重启** - 新添加的SSL路由代码还未加载

## ✅ 解决方案

### 步骤 1: 重启开发服务器

1. **停止当前服务器**
   - 在运行服务器的终端按 `Ctrl + C`

2. **重新启动**
   ```bash
   npm run dev
   ```

3. **等待启动完成**
   - 看到 "Server running on port..." 提示

4. **刷新浏览器**
   - 按 `F5` 或 `Ctrl + R`

### 步骤 2: 验证功能

1. 选择DNS账号
2. 选择域名
3. 应该能看到SSL卡片显示

## 🔧 如果问题仍存在

### 检查服务器日志

查看终端输出，寻找：
```
[CF-DNS] 获取SSL信息失败: xxxx
```

### 常见错误及解决方法

#### 1. Authentication error
**原因**: API Token权限不足  
**解决**: 使用Global API Key

#### 2. Zone not found
**原因**: Zone ID错误  
**解决**: 重新选择域名

#### 3. Method not found
**原因**: 路由未注册  
**解决**: 确认服务器已重启

## 📝 验证清单

- [ ] 服务器已重启
- [ ] 浏览器已刷新
- [ ] 使用Global API Key账号
- [ ] 域名已正确选择
- [ ] 检查浏览器控制台错误
- [ ] 检查服务器终端日志

## 🐛 调试步骤

1. **查看Network标签**
   - F12 → Network
   - 查找 /ssl 请求
   - 点击查看Response

2. **查看Console日志**
   - 寻找 [CF-API] 或 [DNS] 日志

3. **测试API直接调用**
   ```bash
   curl http://localhost:5173/api/cf-dns/accounts/YOUR_ACCOUNT_ID/zones/YOUR_ZONE_ID/ssl
   ```

## 🚀 预期结果

重启后应该看到：
```
✅ 服务器日志: GET /accounts/.../zones/.../ssl 200
✅ 浏览器: SSL卡片显示
✅ 控制台: [DNS] SSL信息已加载
```

---

**快速修复**: 重启服务器 → 刷新浏览器
