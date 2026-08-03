# 提示词库模块 PRD

最后更新：2026-07-30

## Problem Statement

当前用户使用笔记软件管理常用提示词，但在实际使用中存在明显问题：

1. 浏览结构和使用结构混在一起，难以快速定位“真正要发给 AI 的那条 prompt”。
2. 一个笔记页里可能包含多段提示词，但对外部 AI 来说需要的是单条、稳定、直接可取用的内容。
3. 当前笔记工具更适合记录，不适合“收藏、整理、复制、发布、直链调用”。
4. 缺少统一的版本边界，更新提示词后容易把旧直链语义改掉。
5. 缺少公开源码直链，无法把某条 prompt 作为独立资产发给外部 AI 或外部自动化流程。

用户真正需要的不是一个“普通 Markdown 笔记模块”，而是一个：

1. 以提示词条目为核心。
2. 支持集合 / 文件夹整理。
3. 支持沉浸式 Markdown 编辑。
4. 支持公开页面和原始直链。
5. 支持稳定发布版本。
6. 适合把提示词当作“可管理、可发布、可被外部 AI 消费的资产”的模块。

## Goals

1. 在 API Monitor 中新增独立的 `prompts` 模块。
2. 模块名称使用“提示词库”。
3. 使用新的沉浸式文档工作区作为编辑核心。
4. 支持集合 / 文件夹、标签、收藏和搜索。
5. 支持每条提示词拥有独立的公开页面和 AI 直链。
6. 支持“草稿编辑 + 手动发布”模型，避免草稿直接污染公开内容。
7. 支持固定版本直链，确保旧 prompt 可以长期复用。

## Non-Goals

1. 第一阶段不做 AI 生成提示词。
2. 第一阶段不做一键发送到系统内 OpenAI 模块。
3. 第一阶段不做多人协作与评论。
4. 第一阶段不做细粒度 RBAC。
5. 第一阶段不做复杂附件、图片托管和多媒体笔记。
6. 第一阶段不把它做成通用笔记系统。

## Final Decisions

本 PRD 明确采用以下最终决策：

1. 模块 ID 使用 `prompts`。
2. 前端导航名称使用“提示词库”。
3. 分组位置使用 `工具箱 -> 实用工具`。
4. 主数据格式使用 Markdown。
5. 最小发布单元是“提示词条目”，不是长文档中的某一段。
6. 使用“草稿覆盖 + 手动发布版本”模型。
7. 公开页和原始直链只暴露已发布版本，不暴露草稿。
8. 外部 AI 使用的默认直链为原始文本直链，不返回站点 HTML 外壳。
9. 每条提示词使用稳定 `public_id` 作为公开标识，避免内部 ID 暴露。
10. 同时提供：
    - 人类可读公开页
    - AI 可读原始直链
    - 固定版本直链
11. 所有用户可见界面必须使用现有 Kumo 组件体系与现有项目通用原语，不新增自绘基础 UI。

## Solution

新增 `prompts` 模块，围绕“提示词资产”而不是“普通笔记”设计：

1. 左侧管理集合树与条目列表。
2. 中央提供沉浸式 Markdown 编辑工作区。
3. 右侧展示预览、变量说明、版本与公开信息。
4. 后端负责集合树、条目、草稿、发布版本、公开页元数据和直链输出。
5. 数据库存 Markdown 和版本快照；公开页面与摘要从 Markdown 动态生成。

模块应让用户能够：

1. 新建一条 prompt。
2. 把它放进某个集合。
3. 编辑草稿。
4. 手动发布。
5. 复制公开页链接。
6. 复制原始直链给外部 AI。
7. 固定使用某个历史版本的直链。

可见界面约束：

1. 工作区、树形列表、详情侧栏、工具栏、状态区、复制入口全部遵循现有设计规范。
2. 不自绘按钮、输入框、Tabs、Badge、卡片和工具条。
3. 底层 Markdown 引擎只负责编辑能力，不负责产品可见样式。

## Information Architecture

### 模块入口

- 模块 ID：`prompts`
- 模块名称：`提示词库`
- 路由路径：`/prompts`
- 页面文件：`src/js/pages/PromptLibraryPage.jsx`
- 前端分组：`工具箱 -> 实用工具`

### 顶层视图

第一阶段建议保留四个顶层 Tab：

1. `工作区`
   - 集合树
   - 条目列表
   - 当前条目编辑
   - 预览
   - 公开信息
2. `集合`
   - 树形管理
   - 拖拽排序
   - 归档
3. `已发布`
   - 已发布条目列表
   - 公开状态
   - 直链复制
   - 最近访问
4. `设置`
   - 默认可见性
   - 默认发布策略
   - 原始直链输出格式
   - 访问日志保留策略

### 核心对象层级

第一阶段只定义两层对象：

1. `集合`
   - 用于树形组织
2. `提示词条目`
   - 这是最小编辑和最小发布单元

说明：

1. 若用户想要多个不同用途的 prompt，应建立多个条目，而不是把它们塞进同一篇长文里再依赖文内锚点。
2. 一个条目可以是短 prompt，也可以是结构化 Markdown。

## Content Model

### 提示词条目结构

每条提示词条目至少包含：

1. 标题
2. Markdown 正文
3. 摘要
4. 标签
5. 所属集合
6. 收藏状态
7. 公开状态
8. 版本信息
9. 直链信息

### 内容正文规范

第一阶段正文仍采用自由 Markdown，但建议支持以下结构化约定：

1. `## Role`
2. `## Goal`
3. `## Context`
4. `## Constraints`
5. `## Output`
6. `## Variables`

系统可从正文中提取：

1. 标题大纲
2. 变量占位符摘要
3. 字数统计
4. 预览摘要

但正文本身不强制模板化。

## Frontend PRD

### 页面结构

主工作区建议为三栏布局：

1. 左侧
   - 集合树
   - 当前集合条目列表
   - 搜索框
   - 快速新建
2. 中间
   - 提示词标题
   - 编辑器工具栏
   - 沉浸式 Markdown 编辑区
3. 右侧
   - 预览
   - 标签 / 收藏 / 公开状态
   - 版本信息
   - 公开页链接
   - AI 原始直链

### 前端组件建议

```text
src/js/pages/PromptLibraryPage.jsx
src/js/components/prompts/PromptWorkspace.jsx
src/js/components/prompts/PromptCollectionTree.jsx
src/js/components/prompts/PromptEntryList.jsx
src/js/components/prompts/PromptDetailsPanel.jsx
src/js/components/prompts/PromptPublishDialog.jsx
src/js/components/prompts/PromptVersionPanel.jsx
src/js/components/prompts/PromptPublicLinksPanel.jsx
src/js/components/prompts/PromptSettingsPanel.jsx
```

### 页面状态模型

前端至少维护：

1. 集合状态
   - 当前选中集合
   - 展开折叠节点
   - 集合排序
2. 列表状态
   - 搜索词
   - 标签筛选
   - 收藏筛选
   - 已发布筛选
   - 当前选中条目 ID
3. 当前条目状态
   - 元数据
   - `draftRev`
   - 当前 Markdown
   - `dirty`
   - 保存状态
   - 发布状态
4. 版本状态
   - 历史发布版本
   - 当前公开版本
   - 固定版本直链

### 交互要求

用户必须能够：

1. 新建集合。
2. 在集合下新建提示词条目。
3. 收藏条目。
4. 编辑 Markdown 草稿。
5. 查看右侧预览。
6. 手动发布为新版本。
7. 复制：
   - 公开页链接
   - AI 原始直链
   - 固定版本直链
8. 恢复旧版本到草稿。
9. 归档条目或集合。

### 沉浸式编辑要求

提示词库必须直接复用“文档编辑器重构 PRD”中的共享工作区，不再使用旧的表单卡片式 Markdown 编辑器作为主界面。

要求：

1. 默认进入 `source` 或 `split` 模式。
2. 长 prompt 也能舒适编辑。
3. 复制和发布操作必须在顶部显眼位置。
4. 外部链接信息应靠近正文，而不是埋在设置页里。
5. 工作区可见 UI 完全由 Kumo 组件体系组合，不新增模块私有自绘基础控件。

## Backend PRD

### 模块结构

建议新增：

```text
backend-go/internal/prompts/
├── service.go
├── service_test.go
├── store.go
├── types.go
├── markdown.go
├── public.go
└── schema.go
```

职责划分：

1. `service.go`
   - 内部 API 路由
   - 公开 API 路由
   - 参数校验
   - 鉴权
2. `store.go`
   - SQLite 读写
   - 集合树查询
   - 草稿 / 版本 / 日志 / 设置查询
3. `markdown.go`
   - Markdown 摘要提取
   - 变量占位符提取
   - 纯文本导出
   - 标题树提取
4. `public.go`
   - 公开页元数据输出
   - 原始直链输出
   - 访问日志记录
5. `schema.go`
   - 表结构和索引确保

### 路由设计

#### 内部管理 API

统一前缀：

- `/api/prompts`

建议路由：

- `GET /api/prompts/collections`
- `POST /api/prompts/collections`
- `PUT /api/prompts/collections/{id}`
- `DELETE /api/prompts/collections/{id}`
- `GET /api/prompts/entries`
- `POST /api/prompts/entries`
- `GET /api/prompts/entries/{id}`
- `PUT /api/prompts/entries/{id}`
- `DELETE /api/prompts/entries/{id}`
- `POST /api/prompts/entries/{id}/duplicate`
- `GET /api/prompts/entries/{id}/draft`
- `PUT /api/prompts/entries/{id}/draft`
- `POST /api/prompts/entries/{id}/publish`
- `GET /api/prompts/entries/{id}/versions`
- `GET /api/prompts/entries/{id}/versions/{versionId}`
- `POST /api/prompts/entries/{id}/versions/{versionId}/restore`
- `POST /api/prompts/entries/{id}/public/regenerate`
- `GET /api/prompts/settings`
- `PUT /api/prompts/settings`

全部使用 `session auth`。

#### 公开页面与直链

建议新增：

- `GET /api/prompts/public/{publicId}`
- `GET /api/prompts/d/{publicId}`
- `GET /api/prompts/d/{publicId}/versions/{versionNo}`

同时新增前端公开页路由：

- `/p/{publicId}`

公开路由使用 `public auth`。

### 公开输出规则

#### 人类公开页

`/p/{publicId}` 用于：

1. 浏览标题
2. 渲染 Markdown
3. 查看版本号
4. 复制原始直链

#### AI 原始直链

`/api/prompts/d/{publicId}` 是给外部 AI 或自动化工具直接读取的链接。

规则：

1. 默认输出已发布最新版本。
2. 默认响应 `text/plain; charset=utf-8`。
3. 不返回任何站点壳子、导航、HTML 外围布局或脚本。
4. 可选支持：
   - `?format=markdown`
   - `?format=json`

#### 固定版本直链

`/api/prompts/d/{publicId}/versions/{versionNo}` 用于：

1. 固定历史版本
2. 避免后续 prompt 修改影响外部调用

### 发布模型

必须采用“草稿 / 发布”双层模型。

规则：

1. 编辑时只改草稿。
2. 公开页和原始直链始终读取已发布版本。
3. 用户点击“发布”时创建不可变版本。
4. 若要回退旧内容，应将旧版本恢复到草稿，再重新发布。

### 冲突处理

保存草稿使用乐观锁：

1. 前端读取 `draftRev`
2. 保存时提交 `expectedDraftRev`
3. 后端以 `WHERE current_draft_rev = ?` 更新
4. 冲突返回 `409`

发布也必须校验：

1. 只能从当前最新草稿发布
2. 若草稿已冲突，先解决冲突再发布

## Database PRD

### 主存储原则

数据库保存 Markdown 草稿和已发布版本。

以下内容不作为唯一真相：

1. 渲染 HTML
2. 公开页缓存
3. 纯文本导出缓存
4. 变量提取结果

### Tables

#### 1. `prompt_collections`

用途：集合树。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `parent_id INTEGER`
- `name TEXT NOT NULL`
- `description TEXT DEFAULT ''`
- `icon TEXT DEFAULT ''`
- `color_token TEXT DEFAULT ''`
- `sort_order INTEGER DEFAULT 0`
- `archived INTEGER DEFAULT 0`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

索引：

- `idx_prompt_collections_parent_sort`
- `idx_prompt_collections_archived`

#### 2. `prompt_entries`

用途：提示词条目主记录。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `collection_id INTEGER`
- `title TEXT NOT NULL`
- `internal_slug TEXT NOT NULL`
- `public_id TEXT NOT NULL`
- `summary TEXT DEFAULT ''`
- `tags_json TEXT DEFAULT '[]'`
- `starred INTEGER DEFAULT 0`
- `archived INTEGER DEFAULT 0`
- `visibility TEXT NOT NULL DEFAULT 'unlisted'`
- `current_draft_rev INTEGER DEFAULT 1`
- `latest_published_version_id INTEGER`
- `latest_published_version_no INTEGER DEFAULT 0`
- `latest_published_at TEXT`
- `published_char_count INTEGER DEFAULT 0`
- `published_word_count INTEGER DEFAULT 0`
- `outline_json TEXT DEFAULT '[]'`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

约束与索引：

- `UNIQUE(internal_slug)`
- `UNIQUE(public_id)`
- `idx_prompt_entries_collection_updated`
- `idx_prompt_entries_visibility`
- `idx_prompt_entries_starred_updated`

#### 3. `prompt_drafts`

用途：当前草稿。

建议字段：

- `entry_id INTEGER PRIMARY KEY`
- `content_md TEXT NOT NULL`
- `content_text TEXT NOT NULL`
- `outline_json TEXT DEFAULT '[]'`
- `variables_json TEXT DEFAULT '[]'`
- `excerpt_text TEXT DEFAULT ''`
- `updated_at TEXT NOT NULL`

说明：

1. 草稿只有一份。
2. 自动保存永远覆盖该记录。
3. `content_text` 是从 Markdown 提取出的纯文本视图，便于原始直链默认输出。

#### 4. `prompt_versions`

用途：已发布不可变版本。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `entry_id INTEGER NOT NULL`
- `version_no INTEGER NOT NULL`
- `content_md TEXT NOT NULL`
- `content_text TEXT NOT NULL`
- `outline_json TEXT DEFAULT '[]'`
- `variables_json TEXT DEFAULT '[]'`
- `excerpt_text TEXT DEFAULT ''`
- `checksum TEXT NOT NULL`
- `char_count INTEGER DEFAULT 0`
- `word_count INTEGER DEFAULT 0`
- `created_at TEXT NOT NULL`

约束与索引：

- `UNIQUE(entry_id, version_no)`
- `idx_prompt_versions_entry_created`
- `idx_prompt_versions_entry_version`

#### 5. `prompt_access_logs`

用途：记录公开访问。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `entry_id INTEGER NOT NULL`
- `version_id INTEGER`
- `route_kind TEXT NOT NULL`
- `response_format TEXT NOT NULL`
- `ip_hash TEXT DEFAULT ''`
- `user_agent TEXT DEFAULT ''`
- `created_at TEXT NOT NULL`

说明：

1. 不存原始 IP，避免不必要敏感信息。
2. `route_kind` 允许值：
   - `public_page`
   - `direct_latest`
   - `direct_version`

#### 6. `prompt_settings`

用途：模块全局设置。

建议字段：

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `default_visibility TEXT DEFAULT 'unlisted'`
- `default_direct_format TEXT DEFAULT 'text'`
- `allow_public_pages INTEGER DEFAULT 1`
- `allow_direct_links INTEGER DEFAULT 1`
- `access_log_retention_days INTEGER DEFAULT 30`
- `updated_at TEXT NOT NULL`

### Data Integrity Rules

必须满足：

1. 删除条目时级联删除：
   - `prompt_drafts`
   - `prompt_versions`
   - `prompt_access_logs`
2. 公开直链只读取 `prompt_versions`。
3. 草稿内容不能直接被公开接口读取。
4. 每次发布都必须创建新版本，不允许覆盖旧版本。
5. 恢复旧版本时，只能写回草稿，不得篡改历史版本。

## Public Exposure Strategy

### 可见性

第一阶段支持三种可见性：

1. `private`
   - 无公开页
   - 无直链
2. `unlisted`
   - 有公开页和直链
   - 但不出现在公开索引中
3. `public`
   - 预留给未来公开索引能力

默认建议：

- `unlisted`

### 稳定链接策略

每条提示词一旦发布，就拥有稳定 `public_id`。

原则：

1. 用户主动重置前，`public_id` 不变化。
2. 老版本固定链接永久可用，除非用户手动取消公开。
3. 若链接泄漏，可执行“重新生成公开 ID”。

## Performance Decisions

### 列表性能

条目列表 API 默认不返回：

1. 完整 Markdown 正文
2. 历史版本正文
3. 访问日志明细

列表只返回：

1. 标题
2. 摘要
3. 标签
4. 收藏状态
5. 最新发布时间
6. 是否已发布

### 自动保存

要求：

1. 自动保存 `debounce 1500-2000ms`
2. 内容未变化则不写库
3. 自动保存只更新 `prompt_drafts` 与 `prompt_entries`
4. 自动保存不产生发布版本

### 搜索

第一阶段：

1. 标题、摘要、标签、集合名支持直接查询
2. 正文搜索可先走简单 `LIKE`
3. 若后续规模增大，再评估 FTS 扩展

## Security Decisions

### 公开接口边界

公开接口必须遵守：

1. 只暴露已发布版本
2. 不暴露内部条目 ID
3. 不返回后台管理字段
4. 不泄漏草稿、内部备注和未发布内容

### 原始直链输出

AI 原始直链必须：

1. 只输出正文内容或明确约定的结构化 JSON
2. 不混入页面导航、广告、按钮文案或无关 UI 文本
3. `Content-Type` 清晰稳定
4. 支持外部程序直接 `GET`

## User Stories

1. 作为经常使用 AI 的用户，我想把常用 prompt 放进集合里，以便长期整理。
2. 作为经常切换场景的用户，我想给 prompt 打标签，以便快速筛选。
3. 作为 prompt 作者，我想用沉浸式工作区编辑 Markdown，以便专注写作。
4. 作为 prompt 作者，我想随时预览排版，以便确认结构清晰。
5. 作为 prompt 作者，我想让草稿和已发布内容分开，以免外部链接被未完成内容污染。
6. 作为 prompt 使用者，我想复制最新直链，以便直接发给外部 AI。
7. 作为 prompt 使用者，我想复制固定版本直链，以便确保复现旧结果。
8. 作为 prompt 管理者，我想看到已发布版本列表，以便回滚和追溯。
9. 作为 prompt 管理者，我想把条目标星，以便优先访问。
10. 作为 prompt 管理者，我想归档不常用内容，以便保持工作区干净。

## Testing Decisions

### 后端测试

必须覆盖：

1. 集合树 CRUD
2. 条目 CRUD
3. 草稿保存
4. 乐观锁冲突 `409`
5. 发布创建新版本
6. 恢复旧版本到草稿
7. 公开直链只返回已发布版本
8. `public_id` 重置
9. 原始直链 `Content-Type`
10. 访问日志写入

### 前端测试

至少验证：

1. 模块 `/prompts` 直接访问不白屏。
2. 集合树加载与空态正常。
3. 条目列表、搜索、收藏筛选正常。
4. 工作区编辑、自动保存和发布按钮可用。
5. 右侧预览与公开链接面板正常。
6. 复制公开页链接和原始直链可用。
7. 冲突提示可见。
8. 已发布列表和版本恢复可用。

### 公开页测试

必须验证：

1. `/p/{publicId}` 可匿名访问。
2. `/api/prompts/d/{publicId}` 返回原始正文，不返回 HTML 壳。
3. `/api/prompts/d/{publicId}/versions/{versionNo}` 正常工作。
4. 未发布条目不可通过公开路由读取。

### 验收命令

至少运行：

```bash
npm run audit:fast
npm run backend-go:test
node tools/backend-route-inventory.mjs
```

涉及运行态公开页时，再执行：

```bash
npm run backend-go:smoke
```

## Acceptance Criteria

1. 侧边栏出现 `提示词库` 模块，位于 `工具箱 -> 实用工具`。
2. 模块采用沉浸式工作区，而不是旧式表单卡片编辑器。
3. 用户可以创建集合和提示词条目。
4. 用户可以编辑 Markdown 草稿并自动保存。
5. 草稿不会直接出现在公开页面或原始直链中。
6. 用户可以手动发布并生成不可变版本。
7. 每条提示词都有稳定公开页链接和原始直链。
8. 外部 AI 请求原始直链时可以直接获取正文内容。
9. 用户可以复制固定版本直链。
10. 公开接口不暴露内部 ID 和未发布内容。

## Out of Scope

1. 一键把 prompt 发送到系统内 OpenAI 模块。
2. AI 自动生成 prompt。
3. 实时协作。
4. 评论、审核流。
5. 图片、附件、复杂媒体块。
6. 通用私人笔记系统。
