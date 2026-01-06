# 通知模块调试指南

## 🔍 问题排查

通知模块没有显示在导航栏中? 按以下步骤排查:

### 1. 检查浏览器控制台

打开浏览器开发者工具 (F12),查看 Console 标签页是否有错误信息。

**可能的错误**:
- `Failed to fetch module` - 模板加载失败
- `notification is not defined` - 数据未定义
- `Unexpected token` - 语法错误

### 2. 检查模板是否加载

在控制台中运行:
```javascript
// 检查模板容器是否存在
document.querySelector('#template-notification')

// 检查模板内容
document.querySelector('#template-notification').innerHTML
```

如果返回 `null`,说明模板没有加载。

### 3. 检查模块配置

在控制台中运行:
```javascript
// 检查 Pinia store 配置
window.__PINIA_STORE__
```

或者:
```javascript
// 检查 reactive store
window.store
```

查看 `moduleVisibility` 中 `notification` 是否为 `true`。

### 4. 手动触发模板加载

在控制台中运行:
```javascript
// 手动加载通知模板
TemplateLoader.loadTemplates(['notification.html'])
```

### 5. 检查 Vite 开发服务器

如果使用 `npm run dev`,确保 Vite 开发服务器正在运行:

```bash
# 重启 Vite 开发服务器
npm run dev:client
```

### 6. 清除缓存

硬刷新浏览器:
- **Windows/Linux**: `Ctrl + Shift + R` 或 `Ctrl + F5`
- **Mac**: `Cmd + Shift + R`

或者清除浏览器缓存:
1. 打开开发者工具 (F12)
2. 右键点击刷新按钮
3. 选择"清空缓存并硬性重新加载"

### 7. 检查文件完整性

确保以下文件都存在且内容正确:

- [x] `src/templates/notification.html` - 模板文件
- [x] `src/js/modules/notification.js` - JavaScript 模块
- [x] `src/css/notification.css` - 样式文件

运行以下命令检查:
```bash
# Windows
dir src\templates\notification.html
dir src\js\modules\notification.js
dir src\css\notification.css

# Linux/Mac
ls -la src/templates/notification.html
ls -la src/js/modules/notification.js
ls -la src/css/notification.css
```

### 8. 强制重新构建

```bash
# 停止当前服务
# 然后运行
npm run dev
```

### 9. 检查模块分组

在浏览器控制台中运行:
```javascript
// 获取模块分组配置
const appStore = window.$pinia?.state?.value?.app

if (appStore) {
  console.log('模块可见性:', appStore.moduleVisibility)
  console.log('模块分组:', appStore.moduleGroups)
}
```

应该看到:
```javascript
{
  moduleVisibility: {
    // ...
    notification: true  // ← 这应该是 true
  },
  moduleGroups: [
    // ...
    {
      id: 'toolbox',
      name: '工具箱',
      modules: ['self-h', 'totp', 'music', 'notification']  // ← notification 应该在这里
    }
  ]
}
```

## 🎯 快速修复

### 方法 1: 直接访问通知页面

在浏览器地址栏中输入:
```
http://localhost:3000/#notification
```

### 方法 2: 手动设置激活标签

在控制台中运行:
```javascript
// 设置当前标签为通知
const appStore = window.$pinia?.state?.value?.app
if (appStore) {
  appStore.mainActiveTab = 'notification'
}
```

### 方法 3: 检查模板加载器状态

```javascript
// 查看模板加载器
console.log('Template Map:', TemplateLoader.templateMap)
console.log('Loaded Templates:', Object.keys(TemplateLoader.templateMap))
```

应该看到 `'notification.html': '#template-notification'`

## 📋 完整配置检查清单

### Store 配置
- [x] `src/js/store.js` - MODULE_CONFIG 有 notification
- [x] `src/js/store.js` - MODULE_GROUPS 包含 notification
- [x] `src/js/store.js` - moduleVisibility.notification = true
- [x] `src/js/store.js` - moduleOrder 包含 notification

- [x] `src/js/stores/app.js` - MODULE_CONFIG 有 notification
- [x] `src/js/stores/app.js` - MODULE_GROUPS 包含 notification
- [x] `src/js/stores/app.js` - moduleVisibility.notification = true
- [x] `src/js/stores/app.js` - moduleOrder 包含 notification

### 模板配置
- [x] `src/index.html` - 有 `<div id="template-notification">`
- [x] `src/js/template-loader.js` - templateMap 包含 notification.html

### 主应用集成
- [x] `src/js/main.js` - 导入了 notificationData 和 notificationMethods
- [x] `src/js/main.js` - 在 data() 中展开 notificationData
- [x] `src/js/main.js` - 在 methods 中展开 notificationMethods
- [x] `src/js/main.js` - CSS 懒加载包含 notification.css

## 🚨 常见问题

### 问题 1: "Cannot find module './notification.js'"

**原因**: 路径错误或文件不存在

**解决**:
```bash
# 检查文件是否存在
ls -la src/js/modules/notification.js

# 如果不存在,重新创建
# (参考 notification.js 的创建步骤)
```

### 问题 2: 模板加载 404

**原因**: Vite 没有检测到新文件

**解决**: 重启 Vite 开发服务器
```bash
npm run dev
```

### 问题 3: 点击菜单没反应

**原因**: 模板内容为空

**解决**: 检查模板是否正确加载到 DOM
```javascript
// 检查内容
document.querySelector('#template-notification').innerHTML.length
```

应该返回大于 0 的数字。

## 🎉 成功标志

当一切正常时,您应该看到:

1. 导航栏 "工具箱" 下拉菜单中有 "通知" 选项 (🔔 图标)
2. 点击后显示三个子标签: "通知渠道", "告警规则", "通知历史"
3. 页面正常显示,没有控制台错误
4. 可以点击 "添加渠道" 按钮打开弹窗

## 💡 调试技巧

### 使用 Vue DevTools

1. 安装 Vue DevTools 浏览器扩展
2. 打开 DevTools 的 Vue 面板
3. 查看组件树,找到 notification 相关的组件
4. 检查 props 和 data

### 添加调试日志

在 `src/js/main.js` 的 mounted() 钩子中添加:
```javascript
mounted() {
  console.log('Notification Data:', this.notificationChannels)
  console.log('Current Tab:', this.mainActiveTab)
}
```

### 网络请求检查

在 DevTools 的 Network 标签页:
1. 筛选 XHR 请求
2. 查看 `/api/notification/channels` 等请求
3. 确认返回 200 状态码

---

如果以上方法都尝试了还是不行,请提供:
1. 浏览器控制台的完整错误信息
2. `TemplateLoader.templateMap` 的输出
3. `window.store` 或 `window.$pinia.state.value.app` 的输出
