# API Monitor 文档

本目录只保留当前仍有维护价值的文档。历史迁移记录、一次性测试报告和包含本机路径的诊断材料已移除。

## 核心文档

- [开发指南](./开发指南.md)
- [API 接口文档](./API接口文档.md)
- [项目架构与技术详解](./项目架构与技术详解.md)
- [设计文档](./设计文档.md)
- [Oracle OCI 模块技术设计文档](./oracle-oci-technical-design.md)
- [Oracle OCI 模块 API 路由清单](./oracle-oci-api-routes.md)
- [目录结构说明](./目录结构说明.md)
- [贡献指南](./贡献指南.md)

## 开发规范

- [前端开发最佳实践](./前端开发最佳实践.md)
- [Kumo UI 规则](./Kumo%20UI%20规则.md)
- [重构验证与例外清单](./refactor-verification.md)
- [新模块接入指南](./新模块接入指南.md)
- [Go 后端启动指南](./GO后端启动指南.md)

### 前端布局约定

- Kumo `Tabs` 自带外层 ring、内部横向滚动和 active indicator，不要再额外包 `overflow-x-auto`、`overflow-hidden` 或 `p-px/px-px` 容器，否则容易裁掉四周描边并造成 tab 切换时宽度抖动。
- 页面级容器默认保持自然布局和 `overflow: visible`；只有表格、日志、终端、文件列表这类真实滚动区域才放 `overflow-auto`。
- 不要用手动 1px padding 修补 ring 被裁的问题。先检查祖先容器的 `overflow-hidden`、固定 `h-full/min-h-0/flex-1` 工作区和额外滚动壳，优先移除错误的裁切边界。
- 需要让主内容区填满视口时，优先使用父级 `min-h-full flex-1` 和子级 `min-h-0 flex-1` 的 flex/grid 传递，不要硬编码 `calc(100dvh - 9rem)` 这类高度。外层负责分配剩余空间，真实列表、表格或终端面板再在内部滚动。
- 同一个模块的不同 tab 应尽量复用同一种页根布局，不要在“页面自然滚动”和“内部 workspace 视口”两种模式之间来回切换，否则会引入滚动条出现/消失、可用宽度重算和左右位移。
- 如果某个控件看起来比 Cloudflare 官方更“贴边”或更“薄”，先排查页面根字号、祖先裁切容器和滚动壳，再怀疑 Kumo 组件本身；这类问题通常是宿主布局造成的，不是 Tabs、LayerCard 或 Button 自己少了一层边框。

## 参考资料

- [PRD](./prd/)
- [Oracle OCI 主机管理模块 PRD](./prd/oracle-oci-server-management.md)
- [Kumo 参考资料](./reference/)

## 文档安全约定

- 不写入真实密码、Token、Cookie、私钥、会话 ID 或云厂商凭证。
- 示例密钥统一使用 `<PLACEHOLDER>` 形式。
- 示例 IP 优先使用文档保留地址，例如 `203.0.113.10`。
- 本机绝对路径、临时目录、个人用户名和内部域名不要写入文档。
