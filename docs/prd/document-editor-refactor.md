# 文档编辑器重构 PRD

最后更新：2026-07-30

## Problem Statement

当前 API Monitor 已有通用 `CodeEditor` 和一个可视化 `MarkdownEditor`，但现有文档编辑体验仍存在明显问题：

1. 当前 `MarkdownEditor` 更像“表单内嵌控件”，不像可长期停留的主工作区。
2. 可视化编辑直接依赖第三方现成皮肤，和 Kumo 的视觉语言、节奏、空间感不一致。
3. 编辑器头部、模式切换、状态栏和块操作都偏“库默认样式”，缺少产品级统一体验。
4. 文档、提示词、说明页等内容型模块后续都会复用编辑器，若不先重构，后续每个模块都会带着同样的体验债务。
5. 当前实现把第三方编辑器当成“整机”，而不是“编辑内核”，导致我们很难真正掌控沉浸感、主题一致性和模块级工作流。

用户真正需要的不是“再加一个能编辑 Markdown 的组件”，而是一套：

1. 以 Markdown 为主数据。
2. 保留源码模式优势。
3. 外观和交互由 Kumo 主导。
4. 适合沉浸式主工作区。
5. 能被提示词库、文档页、说明页和未来模块共同复用的共享文档编辑体系。

## Research Summary

本次调研重点看了四类现成 Markdown / 富文本基座：

### 1. Tiptap

结论：

1. 优点是 headless、扩展丰富、生态成熟、可自定义空间大。
2. 官方文档明确说明其核心是基于 ProseMirror 的 headless 编辑器，并提供大量扩展能力。
3. 但其官方 Markdown 包当前仍处于 `Beta`，直接作为系统的 Markdown 主存储基座仍有额外风险。

适配判断：

1. 适合作为未来候选。
2. 不适合作为本轮立刻替换基座的首选。

### 2. Lexical

结论：

1. 优点是轻量、极简、插件化强、适合自己完全掌控 UI。
2. 其默认 Markdown 包基于 transformer 体系，可做导入、导出和 typing shortcuts。
3. 官方 `@lexical/mdast` 路线目前仍标记为 `experimental`。

适配判断：

1. 若要做完全自研块编辑器壳层，Lexical 很强。
2. 但以当前仓库节奏看，迁移成本较高，Markdown 语义链路也需要更多宿主侧能力建设。

### 3. Milkdown

结论：

1. 官方将其定义为 WYSIWYG Markdown 编辑框架。
2. 官方文档明确区分三层：`Core`、`Plugins`、`Components`。
3. 当前仓库已经在用 `@milkdown/crepe`，说明依赖与基本运行链路已验证。
4. 当前痛点主要来自“直接使用 Crepe 的现成经典皮肤”，而不是 Milkdown 核心本身。

适配判断：

1. 最适合作为当前阶段的重构目标。
2. 正确方向不是继续包 `Crepe classic.css`，而是下沉到 `Milkdown core + selected plugins/components + Kumo 组合式宿主页`。

### 4. BlockNote

结论：

1. React 集成成熟、上手快、块编辑体验完整。
2. 但官方主路径仍是 `<BlockNoteView />` 这类完整 UI 组件。
3. 对强主题、自定义空间、Kumo 风格一致性要求高的后台系统来说，默认整套 block UI 反而容易再次带入第三方视觉语言。

适配判断：

1. 适合快速得到类 Notion 体验。
2. 不适合当前这个“可见界面必须完全服从现有 Kumo 设计规范”的目标。

## Final Recommendation

本 PRD 最终建议：

1. 第一阶段继续使用 `Milkdown` 家族，但从 `@milkdown/crepe` 的经典皮肤模式，迁移到 `Milkdown core/headless` 路线。
2. `CodeEditor` 继续保留，并升级为源码模式的一等公民，而不是仅作为降级兜底。
3. 主编辑工作区完全由现有 Kumo 组件与现有项目通用原语组合，不再直接复用第三方完整 UI 壳子。
4. 新体系对外暴露统一的“文档编辑器能力层”，供提示词库和未来文档型模块复用。
5. 为未来 `Tiptap` 评估保留清晰适配层，但本轮不立即切换到 Tiptap。

## Goals

1. 让文档编辑器的视觉和交互与 Kumo 统一。
2. 将当前“表单控件式编辑器”升级为“沉浸式工作区编辑器”。
3. 保留 Markdown 作为主数据，不切换到 HTML 作为唯一真相。
4. 保留源码模式、预览模式和可视化模式的共存能力。
5. 让未来提示词库、文档类页面、说明页、帮助页共用同一套文档编辑基础设施。

## Non-Goals

1. 本 PRD 不直接定义提示词库业务模型。
2. 本 PRD 不做实时协作。
3. 本 PRD 不做评论、批注、多人 Presence。
4. 本 PRD 不做 DOCX / PDF 级复杂文档导入导出。
5. 本 PRD 不要求所有现有使用 `CodeEditor` 的表单场景立即迁移到沉浸式工作区。

## Final Decisions

本 PRD 明确采用以下最终决策：

1. Markdown 字符串仍是内容型模块的主数据。
2. 第一阶段编辑引擎采用 `Milkdown core + plugins/components`，不再直接以 `Crepe classic theme` 作为主工作区 UI。
3. 编辑器 UI 分为两层：
   - 轻量嵌入式编辑器
   - 沉浸式工作区编辑器
4. `CodeEditor` 继续作为统一源码编辑底座。
5. 视觉、工具栏、状态条、模式切换、侧栏和块操作 UI 全部改由 Kumo 主导。
6. 所有用户可见控件、工具栏、Tabs、状态区、侧栏和面板必须使用现有 Kumo 组件体系与现有项目通用原语，不新增自绘基础 UI。
7. 新工作区允许以后替换底层富文本引擎，但上层宿主页接口保持稳定。

## Solution

新增一套共享的文档编辑基础设施：

1. `DocumentWorkspace`
   - 用于主工作区型页面
   - 适合提示词库、说明页、内部文档页
2. `EmbeddedMarkdownEditor`
   - 用于表单、小卡片、弹窗、备注输入
3. `MarkdownEngineAdapter`
   - 封装 Milkdown 的初始化、内容同步、只读、事件监听和销毁
4. `DocumentPreviewPane`
   - 统一渲染 Markdown 预览
5. `DocumentToolbar`
   - 用 Kumo 组件重建主工具栏
6. `DocumentOutline`
   - 基于标题树生成导航侧栏

整体原则：

1. 编辑引擎负责“可编辑”。
2. Kumo 组合式宿主页负责“可用、好看、统一”。
3. Markdown 源码负责“可迁移、可审计、可直链、可版本化”。

## Information Architecture

### 编辑器分层

#### 1. 嵌入式编辑器

适用场景：

1. 小表单
2. 设置页说明
3. 弹窗备注
4. 单字段 Markdown 内容

要求：

1. 尺寸紧凑
2. 工具栏精简
3. 支持源码 / 预览
4. 不提供沉浸式侧栏和工作区布局

#### 2. 沉浸式工作区

适用场景：

1. 提示词库主界面
2. 未来知识文档页
3. 需要长时间停留和切换条目的主工作区

要求：

1. 左侧导航可常驻
2. 中央编辑区域全高可停留
3. 右侧元数据 / 大纲 / 预览可切换
4. 顶部工具栏统一由宿主页控制
5. 源码模式与可视模式共享同一条内容状态链路

## Frontend Architecture

### 共享组件规划

建议新增：

```text
src/js/components/editor/
├── DocumentWorkspace.jsx
├── DocumentToolbar.jsx
├── DocumentStatusBar.jsx
├── DocumentModeSwitch.jsx
├── DocumentSidebar.jsx
├── DocumentOutline.jsx
├── DocumentPreviewPane.jsx
├── EmbeddedMarkdownEditor.jsx
├── MarkdownVisualCanvas.jsx
├── MarkdownSourcePane.jsx
├── useDocumentEditorState.js
└── adapters/
    └── milkdownAdapter.js
```

### 组件职责

1. `DocumentWorkspace`
   - 提供全高、三栏或双栏工作区壳
   - 负责布局、响应式和模式切换
2. `DocumentToolbar`
   - 标题
   - 保存状态
   - 视图切换
   - 复制 / 导出 / 发布入口
3. `DocumentStatusBar`
   - 字数
   - 字符数
   - 标题层级数量
   - 最后保存时间
4. `MarkdownVisualCanvas`
   - 只承载编辑画布，不承载产品级边框和头部
5. `MarkdownSourcePane`
   - 基于现有 `CodeEditor`
   - 负责源码查看与编辑
6. `DocumentPreviewPane`
   - 使用现有 Markdown 渲染链路做只读预览

### UI Principles

新编辑器必须满足以下 UI 约束：

1. 不新增自绘按钮、输入框、Tabs、Badge、面板、工具栏和状态条。
2. 不再使用“小卡片输入框”外观作为主工作区。
3. 工具栏由 Kumo `Button`、`Tabs`、`Badge`、`Input` 组成。
4. 主要工作区边界应来自页面布局，不来自多层表单边框。
5. 可视化编辑区与源码编辑区必须在空间感上保持一致。
6. 预览区、源码区、元数据区切换时不能发生明显宽度抖动。
7. 主题切换时颜色、边框、hover、focus 全部遵循现有 Kumo token。

### 编辑模式

沉浸式工作区必须支持三种模式：

1. `write`
   - 视觉编辑优先
   - 隐藏不必要的外围信息
2. `split`
   - 左编辑右预览
   - 或左源码右视觉
3. `source`
   - 纯 Markdown 源码模式
   - 优先服务提示词、技术文档、结构化文本

### 大纲与块导航

编辑器必须支持基于 Markdown 标题的大纲导航：

1. 自动提取 `h1-h6`
2. 支持点击跳转
3. 支持高亮当前标题段
4. 支持折叠右侧面板

### 沉浸式布局要求

工作区页面应进入 `viewport workspace` 模式，而不是普通文档页滚动。

要求：

1. 外层主区域负责分配高度。
2. 左侧树、中央画布、右侧面板分别在内部滚动。
3. loading 分支与正常分支共用同一页根布局。
4. 移动端退化为单栏整页滚动，但保留核心工具栏。

## Editing Engine Decisions

### 为什么不继续直接使用 Crepe 经典壳层

1. 当前仓库的问题并非 Milkdown 不能用，而是我们把 `Crepe classic.css` 直接当产品 UI 使用。
2. 这会带入第三方默认工具栏、默认控件密度和默认空间节奏。
3. 即使改颜色，也无法真正做到 Kumo 化。

### 新引擎接入方式

新的 Milkdown 接入应遵循以下原则：

1. 只保留需要的核心插件和组件。
2. 工具栏、状态栏、命令入口由宿主页控制。
3. 可视化画布尽量只承担：
   - 光标
   - 输入
   - block edit
   - selection
   - 标题 / 列表 / 表格 / 代码块
4. 若某个默认插件强绑定第三方外观，则在第一阶段禁用，改由 Kumo 组件化宿主页替代。

### 适配层要求

必须定义统一适配层接口，例如：

1. `create(container, initialMarkdown, options)`
2. `setMarkdown(markdown)`
3. `getMarkdown()`
4. `setReadonly(readonly)`
5. `focus()`
6. `destroy()`
7. `onChange(listener)`
8. `onSelectionChange(listener)`

作用：

1. 上层工作区不直接依赖具体富文本库实例。
2. 未来若要试验 Tiptap，只需替换适配层实现。

## Data Model & Settings Impact

### 主存储原则

对所有文档型模块，继续采用：

1. Markdown 字符串为主数据。
2. 预览 HTML 为运行时产物，不作为唯一真相。
3. 大纲、字数、摘要等视图信息均可重建。

### 设置持久化

编辑器重构第一阶段不新增独立数据库表，优先复用现有用户设置承载以下偏好：

1. 默认编辑模式
2. 默认分栏方式
3. 右侧面板显隐
4. 是否优先进入源码模式
5. 是否显示字数统计

若后续模块级设置变复杂，再考虑抽离共享设置表。

## Migration Strategy

### Phase 1

1. 保留现有 `CodeEditor`
2. 保留现有 `renderMarkdown`
3. 新建 `DocumentWorkspace`
4. 将当前 `MarkdownEditor` 拆分：
   - 保留轻量嵌入式版本
   - 新建沉浸式版本
5. 去掉对 `Crepe classic.css` 的产品级依赖

### Phase 2

1. 在新模块中优先使用 `DocumentWorkspace`
2. 将现有重内容页面逐步迁移到新工作区
3. 统一工具栏与状态栏样式
4. 收敛重复 Markdown 预览壳子

### Phase 3

1. 若 Phase 1 仍无法满足体验目标，再做 Tiptap 技术 Spike
2. 仅在上层接口稳定后评估底层替换

## API / Backend Impact

第一阶段以纯前端重构为主，不要求新增独立编辑器后端服务。

但要兼容未来模块使用的以下能力：

1. Markdown 内容持久化
2. 摘要提取
3. 版本化
4. 发布与公开页面
5. 直链输出

因此前端工作区组件必须保持与业务存储层解耦，不直接内嵌 API 细节。

## Testing Decisions

### 前端测试

至少覆盖：

1. `DocumentWorkspace` 在三种模式下都不白屏。
2. `CodeEditor` 与新 `MarkdownVisualCanvas` 切换时内容不丢失。
3. `onChange`、`readonly`、`setMarkdown` 链路稳定。
4. 大纲提取正确。
5. 窄屏下布局不重叠。
6. 主题切换后主要边框、背景、文字可读。

### 回归验证

至少验证以下现有能力不退化：

1. 现有使用 `CodeEditor` 的页面不受影响。
2. 公开 Markdown 预览仍正常渲染。
3. 原 `MarkdownEditor` 嵌入式场景仍可用。

### 验收命令

至少运行：

```bash
npm run audit:fast
npm run build
```

若改动共享状态或模块接入，再执行：

```bash
node tools/backend-route-inventory.mjs
```

## Acceptance Criteria

1. 新文档编辑器主工作区不再表现为“表单卡片输入框”。
2. 当前第三方经典皮肤不再直接主导产品视觉。
3. 顶部工具栏、模式切换、状态栏全部由现有 Kumo 组件体系控制，且不新增自绘基础 UI。
4. 源码模式继续基于共享 `CodeEditor`。
5. 可视模式与源码模式切换时内容不丢失。
6. 工作区支持 `write`、`split`、`source` 三种模式。
7. 编辑器可以被提示词库直接复用，而不需要再次包一层页面级壳子。
8. 新工作区在桌面端具备沉浸式停留能力，在移动端能合理退化。

## Out of Scope

1. 实时协作。
2. 评论与批注。
3. DOCX / PDF 富格式往返保真。
4. 所有历史内容页一次性迁移。
5. 底层立即切换到 Tiptap 或 Lexical。
