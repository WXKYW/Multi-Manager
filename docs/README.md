# API Monitor 文档

- [安全加固与扫描计划](./安全加固与扫描计划.md)

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
- 视口型页面的底部与两侧 gutter 由 `MainLayout.jsx` 统一负责；大屏按 `lg:px-6` / `pb-6` 对齐时，页面内部不要再额外补一层页面级 `pb-*`，否则底部会比左右更厚。
- `PageStack` 默认适合自然文档页。不要为了“看起来更满”就把页面强行改成 viewport 工作区；不适合内部滚动的页面，直接让整页滚动，只要底部间距仍由主布局统一提供即可。
- 只有 Cloudflare、API 网关、API 接口文档这类桌面端确实需要固定工具栏、双栏面板或表格内部滚动的页面，才使用无底部 padding 的 viewport 变体，并把 `h-full / min-h-0 / flex-1` 链路传到底层滚动容器。
- 不要把“页面是否属于视口工作区”的判断散落在页面内部和硬编码高度里。应由 `MainLayout.jsx` 统一声明页面走 `document`、`viewport` 或“移动端整页滚动 + 桌面端内部滚动”的响应式工作区模式，页面内部只负责具体分栏和表格/列表滚动。
- 桌面端需要表格或双栏面板内部滚动时，优先让外层 `<main>` 在对应断点改为 `overflow-hidden`，再让页面根、分栏容器、表格壳依次提供 `min-h-0 flex-1`；不要只给最里层表格写 `height: 100%` 或 `overflow: auto`，否则高度链一断就会退回整页滚动。
- 修这类高度问题时必须同时检查 loading 分支和正常分支是否共用同一页根布局；只修主分支、漏掉 skeleton/loading 容器，会造成首屏和加载后高度行为不一致。
- 同一个模块的不同 tab 应尽量复用同一种页根布局，不要在“页面自然滚动”和“内部 workspace 视口”两种模式之间来回切换，否则会引入滚动条出现/消失、可用宽度重算和左右位移。
- 如果某个控件看起来比 Cloudflare 官方更“贴边”或更“薄”，先排查页面根字号、祖先裁切容器和滚动壳，再怀疑 Kumo 组件本身；这类问题通常是宿主布局造成的，不是 Tabs、LayerCard 或 Button 自己少了一层边框。
- `grid` 默认会拉伸同一行的卡片高度。内容型卡片、右侧操作栏、事件目录、导入执行面板等不需要等高时，在父级使用 `items-start`，必要时给子卡片加 `self-start`，不要用固定高度或多余 padding 填补底部空白。
- 卡片内部如果出现大块空白，优先检查外层 `grid items-stretch`、卡片自身 `h-full/min-h-*`、`flex-1`、`justify-between` 和 `bodyClassName` 是否把内容区撑满；只有确实承载图表、表格、终端或列表视口时才保留等高布局。
- 响应式卡片列表优先使用明确断点，例如 `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`。不要用过窄的固定 `minmax()` 上限造成大屏列数不足，也不要让占位卡片和真实卡片使用不同的高度模型。
- 预览型画布只需要“看个大概”时，不要重新计算节点布局。保留节点原始相对位置，先按包围盒归一化，再整体缩放；外框容器保持 `overflow-visible`，只把裁切放在内部 viewport，避免边框或 ring 被裁。
- 登录、初始化和密钥输入必须逐个核对具体输入框，不要只按页面关键字替换。管理员密码、新密码、确认密码使用 `type="password"`；2FA 验证码仍使用 `type="text"` + `inputMode="numeric"`。
- 将自绘按钮、占位操作、状态标签等替换为 Kumo 组件时，保留语义和交互状态：按钮用 `Button`，状态用 `Badge/StatusBadge`，可复制文本用 `ClipboardText`，面板优先用 `SectionCard/LayerCard`。替换后要检查 hover、focus、disabled、loading 和无数据状态是否仍然完整。
- 导入/导出、批量操作、自动刷新等配置区应保持紧凑一致：相关操作尽量合并到同一控制组，避免同一模块在“自然页面滚动”和“内部工作区视口”之间切换。

## 参考资料

- [PRD](./prd/)
- [Oracle OCI 主机管理模块 PRD](./prd/oracle-oci-server-management.md)
- [Kumo 参考资料](./reference/)

## 文档安全约定

- 不写入真实密码、Token、Cookie、私钥、会话 ID 或云厂商凭证。
- 示例密钥统一使用 `<PLACEHOLDER>` 形式。
- 示例 IP 优先使用文档保留地址，例如 `203.0.113.10`。
- 本机绝对路径、临时目录、个人用户名和内部域名不要写入文档。
