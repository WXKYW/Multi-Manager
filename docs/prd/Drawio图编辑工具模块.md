# Draw.io 图编辑工具模块 PRD

最后更新：2026-07-30

## Problem Statement

当前 API Monitor 已覆盖主机、云服务、可用性监测、定时任务、通知、文件柜和 API 网关，但缺少一个适合长期纳管 draw.io 图文档的可视化编辑模块。

用户当前高频流程是：

1. 让 AI 生成 draw.io XML。
2. 导入到 draw.io 中做人工微调。
3. 再导出为 `.drawio`、XML 或图片留档。

这套流程现在分散在外部网站、本地文件、临时脚本和剪贴板之间，存在几个核心问题：

1. XML、草稿、缩略图和版本分散，缺少统一管理入口。
2. 每次修改都依赖手动导入导出，容易丢失最新草稿。
3. 缺少“当前草稿”和“稳定版本”的边界，容易误覆盖。
4. 缺少图库、模板与复用能力，重复绘图成本高。
5. 后续若要接入 AI 改图能力，当前没有统一的数据模型和编辑宿主。

用户真正需要的不是一个“普通 XML 文本框”，而是一个基于官方 draw.io 编辑器、适合长期保存 XML 图文档、支持草稿覆盖与手动快照、并能继续扩展 AI 改图能力的工具模块。

## Feasibility Conclusion

该模块在当前仓库中可行，且建议按以下路线实施：

1. 第一阶段只做编辑器本体，不做 AI，不做公开页，不做用户管理。
2. 编辑器必须使用官方 diagrams.net / draw.io，自托管后通过 iframe + `postMessage` 的 embed mode 集成。
3. 主数据使用数据库保存未压缩官方 `mxfile` XML，不把 `.drawio` 文件作为内部唯一真相。
4. 缩略图和导出使用“在线导出优先，后台离线重建兜底”的混合渲染链路。
5. 当前系统仍沿用现有 session auth，所有已登录管理员共享同一套图文档，不引入文档级用户归属。

该方案和当前仓库约束是兼容的：

1. 前端已有模块化导航和独立页面挂载能力。
2. 后端已有 manifest 驱动的路由治理方式。
3. SQLite 已是当前系统的标准存储。
4. `cfg.DataDir` 已提供模块级磁盘存储目录。
5. 文件柜、备份、OpenAI 接入等模块已提供可复用的存储、导出和后续 AI 扩展参考。

## Goals

1. 在 API Monitor 中新增独立的 `drawio` 工具模块。
2. 第一阶段先完成官方编辑器宿主、图文档管理、版本快照、缩略图和导入导出。
3. 使用数据库保存未压缩官方 `mxfile` XML 作为唯一主数据。
4. 使用“草稿覆盖 + 手动快照”作为版本模型。
5. 提供图库、导入、导出、缩略图和版本回滚能力。
6. 支持外链图片，但不让保存与版本化依赖外链一定可达。
7. 为未来 AI 生成与修改能力预留数据结构、前端宿主和后端接口边界。

## Non-Goals

1. 第一阶段不做 AI 生成、AI 修改、提示词管理和模型选择。
2. 第一阶段不做公开页。
3. 第一阶段不做用户管理、多租户、团队协作和细粒度 RBAC。
4. 第一阶段不做实时协同编辑。
5. 第一阶段不做 Git 式分支、patch merge 或 XML 自动合并。
6. 第一阶段不自研 draw.io 兼容编辑器。

## Final Decisions

本 PRD 明确采用以下最终决策：

1. 模块 ID 使用 `drawio`。
2. 前端导航名称使用“图编辑器”。
3. 分组位置使用 `工具箱 -> 实用工具`。
4. 编辑器使用官方 diagrams.net / draw.io 编辑器，自托管嵌入。
5. 编辑器宿主通过 iframe + `postMessage` 的 embed mode 集成。
6. 主数据使用数据库保存未压缩官方 `mxfile` XML。
7. 导入时允许 `.drawio` 和 `.xml`，入库前统一归一化为未压缩 `mxfile` XML。
8. 导出默认格式为 `.drawio`，并支持 `.xml`、`.svg`。
9. 草稿覆盖保存，不自动生成历史版本。
10. 用户点击“保存版本”时才生成不可变快照。
11. 缩略图全部视为可重建缓存，不作为唯一真相。
12. 外链图片允许，但后台渲染链路必须具备私网拦截和失败降级能力。
13. 所有用户可见界面必须使用现有 Kumo 组件体系与现有项目通用原语，不新增自绘基础 UI。

## Solution

新增 `drawio` 模块，提供一个围绕官方编辑器的“薄宿主页面”：

1. 前端负责页面结构、图列表、版本列表、导入导出、缩略图展示、草稿状态和冲突提示。
2. iframe 内运行自托管官方编辑器，负责真实绘图与 XML 编辑。
3. 后端负责文档元数据、草稿、版本、缩略图状态、导入导出、冲突控制和后台重建。
4. 主数据统一使用 SQLite 保存 XML，磁盘只保存缩略图缓存、导出缓存和本地化素材。

模块第一阶段仅提供四个页面级视图：

1. `主界面`
2. `图库`
3. `版本`
4. `设置`

未来若接入 AI，再在 `主界面` 中扩展 AI 辅助侧栏，不新增一级导航。

## Information Architecture

### 模块入口

- 模块 ID：`drawio`
- 模块名称：`图编辑器`
- 路由路径：`/drawio`
- 页面文件：`src/js/pages/DrawioPage.jsx`
- 前端分组：`工具箱 -> 实用工具`

### Tabs 规划

第一阶段仅保留四个顶层 Tab：

1. `主界面`
   - 编辑器本体
   - 导入 / 导出
   - XML 源码查看
   - 草稿状态
   - 冲突提示
2. `图库`
   - 图文档列表
   - 缩略图卡片
   - 标签 / 类型 / 最近编辑筛选
   - 新建图、复制图、归档图
3. `版本`
   - 当前文档的历史版本列表
   - 版本备注
   - 历史缩略图
   - 从旧版本恢复到新草稿
4. `设置`
   - 编辑器默认参数
   - 导入导出默认格式
   - 缩略图重建策略
   - 外链图片策略和安全提示

明确不在第一阶段暴露的视图：

1. `公开页`
2. `用户管理`
3. `访问控制`
4. `AI`

### 权限模型

第一阶段沿用当前系统认证模型：

1. 访问方式为现有 `session auth`。
2. 不引入文档所有者字段，也不做用户隔离。
3. 所有已登录管理员共享图文档集合。
4. 因共享编辑而产生的覆盖风险，通过乐观锁解决。

## Frontend PRD

### 页面结构

建议页面结构如下：

1. 顶部工具栏
   - 文档标题
   - 保存状态
   - 手动保存版本
   - 导入
   - 导出
   - 重建缩略图
2. 主体三栏
   - 左侧：图库 / 模板 / 当前文档摘要
   - 中间：官方编辑器 iframe
   - 右侧：XML 源码 / 文档属性 / 外链资源警告

### 前端组件建议

- `src/js/pages/DrawioPage.jsx`
- `src/js/components/drawio/DrawioFrame.jsx`
- `src/js/components/drawio/DrawioWorkspace.jsx`
- `src/js/components/drawio/DrawioLibraryPanel.jsx`
- `src/js/components/drawio/DrawioVersionPanel.jsx`
- `src/js/components/drawio/DrawioXmlPanel.jsx`
- `src/js/components/drawio/DrawioImportDialog.jsx`
- `src/js/components/drawio/DrawioExportDialog.jsx`
- `src/js/components/drawio/DrawioSettingsPanel.jsx`
- `src/js/components/drawio/DrawioConflictDialog.jsx`

### 页面状态模型

前端至少维护以下四类状态：

1. 图库状态
   - 查询词
   - 当前筛选标签
   - 归档筛选
   - 排序方式
   - 当前选中文档 ID
2. 当前文档状态
   - 元数据
   - `draftRev`
   - 当前 XML
   - `xmlHash`
   - `dirty`
   - `saveState`
   - `conflictState`
3. 编辑器状态
   - iframe 是否已 ready
   - 当前主题
   - 当前页面 ID
   - 最近一次导出结果
4. 版本与设置状态
   - 当前文档版本列表
   - 全局模块设置
   - 缩略图重建状态

### 编辑器集成

编辑器必须通过官方 embed mode 集成：

1. iframe 指向同源自托管编辑器地址。
2. 宿主页向 iframe 发送：
   - 初始 XML
   - 编辑器配置
   - 导出请求
   - 保存前的 XML 拉取请求
3. iframe 返回：
   - 当前 XML
   - 导出 SVG / PNG / `.drawio`
   - 页面信息
   - 编辑器状态
   - 资源引用摘要

建议封装统一消息协议：

1. `host:init`
2. `host:load-document`
3. `host:request-current-xml`
4. `host:request-export`
5. `host:set-theme`
6. `editor:ready`
7. `editor:change`
8. `editor:current-xml`
9. `editor:export-result`
10. `editor:error`

### 主题一致性

不要求 iframe 内部 100% 复刻 Kumo 视觉，但必须做到：

1. 宿主页完全使用 Kumo 组件与项目主题。
2. 宿主页主题切换时同步通知 iframe 切换浅色 / 深色模式。
3. 外层工具栏、按钮、弹窗、列表和状态提示全部由宿主页提供。
4. 尽量隐藏不必要的编辑器原生顶栏按钮，避免视觉与交互冗余。
5. 除官方编辑器 iframe 画布外，所有用户可见业务控件不得自绘。

### 多页文档支持

draw.io 官方 `mxfile` 允许多页文档，第一阶段必须直接支持：

1. 一个数据库文档对应一个完整 `mxfile`。
2. 不把单页拆成多条数据库记录。
3. 后端在保存草稿和版本时提取：
   - `page_count`
   - `page_names_json`
   - 当前封面页信息
4. 图库缩略图默认展示封面页：
   - 优先使用最近编辑页
   - 如果没有最近编辑页，则使用第一页

### 前端交互要求

用户必须能在前端直接完成以下动作：

1. 新建空白图。
2. 导入 `.drawio` / `.xml`。
3. 在 iframe 中编辑。
4. 看到草稿是否已保存。
5. 手动保存版本并填写备注。
6. 查看 XML 源码。
7. 导出 `.drawio`、`.xml`、`.svg`。
8. 看到外链资源数量、域名摘要和最近扫描时间。
9. 在冲突发生时执行刷新、另存为新文档或复制本地 XML。

## Backend PRD

### 模块结构

建议新增：

```text
backend-go/internal/drawio/
├── service.go
├── service_test.go
├── store.go
├── renderer.go
├── types.go
├── xml.go
└── schema.go
```

职责划分：

1. `service.go`
   - HTTP 路由分发
   - 权限校验
   - 请求参数校验
   - JSON / 文件响应
2. `store.go`
   - SQLite 读写
   - 草稿 / 版本 / 设置 / 渲染任务读写
3. `renderer.go`
   - 缩略图生成和重建
   - 导出调度
   - 渲染任务执行
4. `xml.go`
   - `.drawio` / XML 归一化
   - 压缩页解压
   - 哈希计算
   - 外链资源提取
   - 页信息摘要提取
5. `schema.go`
   - `CREATE TABLE IF NOT EXISTS`
   - 动态列补齐
   - 索引确保

### 路由设计

模块 API 前缀统一使用 `/api/drawio`：

- `GET /api/drawio/documents`
- `POST /api/drawio/documents`
- `GET /api/drawio/documents/{id}`
- `PUT /api/drawio/documents/{id}`
- `DELETE /api/drawio/documents/{id}`
- `POST /api/drawio/documents/{id}/clone`
- `GET /api/drawio/documents/{id}/draft`
- `PUT /api/drawio/documents/{id}/draft`
- `POST /api/drawio/documents/{id}/versions`
- `GET /api/drawio/documents/{id}/versions`
- `GET /api/drawio/documents/{id}/versions/{versionId}`
- `POST /api/drawio/documents/{id}/versions/{versionId}/restore`
- `POST /api/drawio/import`
- `GET /api/drawio/documents/{id}/export`
- `POST /api/drawio/documents/{id}/thumbnails/rebuild`
- `POST /api/drawio/thumbnails/rebuild`
- `GET /api/drawio/render-jobs`
- `GET /api/drawio/settings`
- `PUT /api/drawio/settings`

全部接口使用 `session auth`。

### 核心 API 对象

#### `DocumentSummary`

用于图库列表，禁止携带大 XML 正文：

- `id`
- `title`
- `description`
- `tags`
- `archived`
- `pageCount`
- `coverPageName`
- `draftRev`
- `latestVersionNo`
- `thumbnailUrl`
- `thumbnailStatus`
- `updatedAt`

#### `DocumentDetail`

用于当前文档详情：

- `id`
- `title`
- `description`
- `tags`
- `archived`
- `pageCount`
- `pageNames`
- `coverPageId`
- `coverPageName`
- `draftRev`
- `latestVersionId`
- `latestVersionNo`
- `thumbnailUrl`
- `thumbnailStatus`
- `lastExternalAssetScanAt`
- `createdAt`
- `updatedAt`

#### `DraftPayload`

- `documentId`
- `xmlContent`
- `xmlHash`
- `expectedDraftRev`
- `currentDraftRev`
- `baseVersionId`
- `editorState`
- `externalAssets`
- `updatedAt`

#### `VersionPayload`

- `id`
- `documentId`
- `versionNo`
- `summary`
- `xmlHash`
- `pageCount`
- `coverPageName`
- `thumbnailUrl`
- `thumbnailStatus`
- `createdAt`

#### `SettingsPayload`

- `defaultExportFormat`
- `defaultThemeMode`
- `autosaveEnabled`
- `autosaveDebounceMs`
- `documentSizeLimitBytes`
- `versionSoftLimit`
- `allowExternalAssets`
- `blockPrivateNetworkAssets`
- `thumbnailFormat`
- `thumbnailMaxWidth`
- `thumbnailMaxHeight`

### 服务端安全头例外

当前系统统一设置 `X-Frame-Options: DENY`。由于自托管编辑器必须被主站 iframe 嵌入，需要对 `/vendor/drawio/` 路径做窄例外：

1. `/vendor/drawio/` 静态资源响应不再设置 `X-Frame-Options: DENY`。
2. 该路径改为设置：
   - `Content-Security-Policy: frame-ancestors 'self'`
3. 其他业务路由和 API 仍保留原有安全头，不受影响。

该例外只对编辑器静态资源生效，不对其他业务页面开放 iframe 嵌入。

### 渲染链路设计

这是本模块最关键的实现点之一，必须单独定义。

#### 在线导出链路

当用户正在编辑某个文档时：

1. 宿主页通过 iframe 请求官方编辑器导出当前页面。
2. 编辑器返回 `.drawio`、XML、SVG 或缩略图 SVG。
3. 宿主页可以直接下载导出结果，或把缩略图上传给后端缓存。

该链路优先用于：

1. 当前文档导出
2. 当前文档保存后立即更新缩略图
3. 手动保存版本时生成版本缩略图

#### 后台离线重建链路

当缩略图文件丢失、批量重建或用户触发“重建缩略图”时：

1. 后端创建 `drawio_render_jobs` 任务。
2. 渲染执行器启动本地 headless browser。
3. headless browser 加载同源 `/vendor/drawio/` 页面并注入目标 XML。
4. 使用与在线导出一致的官方导出能力生成 SVG。
5. 回写 `thumbnail_path`、`thumbnail_status`、`thumbnail_error`。

该链路的设计目标是：

1. 不自己实现 draw.io 渲染器。
2. 保持与官方编辑器导出结果一致。
3. 支持批量重建和文件丢失后的自动恢复。

#### 渲染失败降级

若渲染执行器不可用或导出失败：

1. 文档保存仍必须成功。
2. 缩略图状态置为 `missing` 或 `failed`。
3. 图库显示占位图。
4. 用户可继续编辑和版本化。

### 外链资源安全边界

第一阶段允许外链图片，但服务端必须阻断明显危险的后台抓取：

1. 后台离线渲染只允许 `http` / `https`。
2. 默认阻止访问：
   - `localhost`
   - `127.0.0.0/8`
   - `10.0.0.0/8`
   - `172.16.0.0/12`
   - `192.168.0.0/16`
   - 链路本地和保留地址段
3. 对被阻断或超时的外链：
   - 不影响 XML 保存
   - 不影响手动保存版本
   - 只影响缩略图或导出完整性
4. 前端必须明确提示：
   - 当前文档含外链
   - 后台缩略图可能因安全策略降级

### 备份与恢复要求

由于主 XML 存在数据库中，本模块的数据应拆成两类：

1. 必须备份的数据
   - `drawio_*` 表
   - `data/drawio/assets/`
2. 可重建的缓存
   - `data/drawio/thumbs/`
   - `data/drawio/exports/`

第一阶段必须在备份设计中明确：

1. 现有数据库备份天然覆盖 XML、草稿、版本和设置。
2. 备份服务后续接入时，必须把 `drawio/assets/` 纳入压缩范围。
3. `thumbs/` 和 `exports/` 默认可不备份，因为可重建。

## Database PRD

### 主存储原则

数据库中的未压缩官方 `mxfile` XML 为唯一主数据。

以下内容不作为唯一真相：

1. 缩略图
2. 导出文件
3. PNG / SVG 预览
4. 外链资源探测缓存

### Storage Layout

磁盘目录统一落在 `cfg.DataDir` 下：

```text
data/
└── drawio/
    ├── thumbs/
    ├── exports/
    └── assets/
```

说明：

1. `thumbs/` 存缩略图缓存。
2. `exports/` 存导出缓存或短期可复用产物。
3. `assets/` 存用户主动上传并本地化的图片素材。
4. 主 XML 不落盘，不把 `.drawio` 文件当唯一主数据。

### Tables

#### 1. `drawio_documents`

用途：图文档主记录，不直接承载草稿 XML。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `title TEXT NOT NULL`
- `description TEXT DEFAULT ''`
- `tags_json TEXT DEFAULT '[]'`
- `archived INTEGER DEFAULT 0`
- `page_count INTEGER DEFAULT 1`
- `page_names_json TEXT DEFAULT '[]'`
- `cover_page_id TEXT DEFAULT ''`
- `cover_page_name TEXT DEFAULT ''`
- `current_draft_rev INTEGER DEFAULT 1`
- `latest_version_id INTEGER`
- `latest_version_no INTEGER DEFAULT 0`
- `thumbnail_path TEXT`
- `thumbnail_status TEXT DEFAULT 'missing'`
- `thumbnail_error TEXT DEFAULT ''`
- `thumbnail_updated_at TEXT`
- `last_external_asset_scan_at TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

索引：

- `idx_drawio_documents_updated_at`
- `idx_drawio_documents_archived_updated`
- `idx_drawio_documents_title`

#### 2. `drawio_drafts`

用途：仅存当前草稿。

建议字段：

- `document_id INTEGER PRIMARY KEY`
- `xml_content TEXT NOT NULL`
- `xml_hash TEXT NOT NULL`
- `base_version_id INTEGER`
- `editor_state_json TEXT DEFAULT '{}'`
- `external_assets_json TEXT DEFAULT '[]'`
- `last_active_page_id TEXT DEFAULT ''`
- `updated_at TEXT NOT NULL`

说明：

1. 草稿只保留一份。
2. 自动保存永远覆盖该记录。
3. 与 `drawio_documents.current_draft_rev` 共同实现乐观锁。

#### 3. `drawio_versions`

用途：不可变手动快照。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `document_id INTEGER NOT NULL`
- `version_no INTEGER NOT NULL`
- `xml_content TEXT NOT NULL`
- `xml_hash TEXT NOT NULL`
- `summary TEXT DEFAULT ''`
- `page_count INTEGER DEFAULT 1`
- `cover_page_id TEXT DEFAULT ''`
- `cover_page_name TEXT DEFAULT ''`
- `thumbnail_path TEXT`
- `thumbnail_status TEXT DEFAULT 'missing'`
- `thumbnail_error TEXT DEFAULT ''`
- `thumbnail_updated_at TEXT`
- `created_at TEXT NOT NULL`

约束与索引：

- `UNIQUE(document_id, version_no)`
- `idx_drawio_versions_document_created_at`
- `idx_drawio_versions_document_version_no`

#### 4. `drawio_assets`

用途：记录资源引用摘要和本地化素材。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `document_id INTEGER NOT NULL`
- `owner_kind TEXT NOT NULL`
- `owner_id INTEGER NOT NULL`
- `source_kind TEXT NOT NULL`
- `original_url TEXT DEFAULT ''`
- `local_path TEXT DEFAULT ''`
- `mime_type TEXT DEFAULT ''`
- `status TEXT NOT NULL DEFAULT 'active'`
- `width INTEGER`
- `height INTEGER`
- `size_bytes INTEGER DEFAULT 0`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`owner_kind` 允许值：

- `draft`
- `version`

`source_kind` 允许值：

- `external`
- `uploaded`
- `embedded`

说明：

1. 允许外链图片时，`local_path` 可以为空。
2. 该表主要用于提示、扫描和后续本地化。
3. 不强制所有资源都下载到本地。

#### 5. `drawio_render_jobs`

用途：后台缩略图重建任务持久化。

建议字段：

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `document_id INTEGER NOT NULL`
- `version_id INTEGER`
- `source_kind TEXT NOT NULL`
- `target_kind TEXT NOT NULL`
- `format TEXT NOT NULL`
- `trigger_source TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'pending'`
- `attempt_count INTEGER DEFAULT 0`
- `last_error TEXT DEFAULT ''`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `started_at TEXT`
- `finished_at TEXT`

`source_kind` 允许值：

- `draft`
- `version`

`target_kind` 允许值：

- `thumbnail`

`status` 允许值：

- `pending`
- `running`
- `succeeded`
- `failed`

说明：

1. 第一阶段主要用于缩略图重建。
2. 后续若要做异步导出，也复用该表。

#### 6. `drawio_settings`

用途：模块全局设置，一行记录。

建议字段：

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `default_export_format TEXT DEFAULT 'drawio'`
- `default_theme_mode TEXT DEFAULT 'system'`
- `autosave_enabled INTEGER DEFAULT 1`
- `autosave_debounce_ms INTEGER DEFAULT 2000`
- `document_size_limit_bytes INTEGER DEFAULT 5242880`
- `version_soft_limit INTEGER DEFAULT 100`
- `allow_external_assets INTEGER DEFAULT 1`
- `block_private_network_assets INTEGER DEFAULT 1`
- `thumbnail_format TEXT DEFAULT 'svg'`
- `thumbnail_max_width INTEGER DEFAULT 480`
- `thumbnail_max_height INTEGER DEFAULT 320`
- `updated_at TEXT NOT NULL`

### Data Integrity Rules

必须满足以下规则：

1. `drawio_documents` 删除时，必须级联删除：
   - `drawio_drafts`
   - `drawio_versions`
   - `drawio_assets`
   - `drawio_render_jobs`
2. 每次草稿保存成功后，都要：
   - 更新 `xml_hash`
   - 更新 `updated_at`
   - 递增 `current_draft_rev`
   - 刷新页元数据
3. 每次手动保存版本时，都要：
   - 复制当前草稿 XML
   - 递增 `version_no`
   - 更新 `latest_version_id`
   - 更新 `latest_version_no`
4. 缩略图文件丢失时，不允许影响文档读取。

## File Format Decisions

### 内部主数据

内部主数据使用：

- 未压缩官方 `mxfile` XML

理由：

1. 与官方格式一致。
2. 便于后续 AI 直接读取和修改。
3. 便于做 XML 哈希、摘要提取和冲突比较。
4. 不需要每次读写都先解压。

### 导入

允许导入：

1. `.drawio`
2. `.xml`

导入后统一归一化为未压缩 `mxfile` XML 存库。

归一化必须覆盖：

1. 压缩页解压
2. 非法空文档兜底
3. 页信息提取
4. 外链资源扫描

### 导出

第一阶段支持：

1. `.drawio`
2. `.xml`
3. `.svg`

`.drawio` 作为默认导出格式。

## Core Workflows

### 1. 新建文档

1. 前端提交标题和标签。
2. 后端创建 `drawio_documents`。
3. 后端写入默认空白 `mxfile` 到 `drawio_drafts`。
4. 返回文档详情和初始草稿。

### 2. 导入文档

1. 用户上传 `.drawio` 或 `.xml`。
2. 后端读取文件内容并归一化为未压缩 `mxfile` XML。
3. 后端提取页信息、哈希和外链摘要。
4. 创建文档和草稿记录。
5. 若用户立即进入主界面，则前端加载草稿到 iframe。

### 3. 打开文档

1. 图库只请求 `DocumentSummary` 列表。
2. 进入主界面后请求：
   - 文档详情
   - 当前草稿
   - 当前文档版本列表
3. iframe ready 后加载 XML。

### 4. 自动保存草稿

1. iframe 内容发生变化。
2. 前端 `debounce` 拉取当前 XML。
3. 若 `xml_hash` 未变化，则跳过保存。
4. 若变化，则带 `expectedDraftRev` 调用保存接口。
5. 保存成功后刷新 `draftRev` 和保存时间。

### 5. 手动保存版本

1. 用户点击“保存版本”。
2. 前端先确保当前 XML 已同步为最新草稿。
3. 前端提交版本备注和 `expectedDraftRev`。
4. 后端把当前草稿复制到 `drawio_versions`。
5. 在线导出一张版本缩略图，失败时不回滚版本。

### 6. 恢复历史版本

1. 用户在版本页选择某个版本。
2. 后端读取该版本 XML。
3. 将其覆盖到当前草稿。
4. 递增 `current_draft_rev`。
5. 前端重新加载 iframe，但不修改历史版本记录本身。

### 7. 缩略图重建

1. 用户手动触发或列表发现缩略图缺失。
2. 后端创建 `drawio_render_jobs`。
3. 渲染执行器异步处理。
4. 成功则回写缩略图路径。
5. 失败则记录错误并保留占位图。

### 8. 删除文档

1. 前端默认先引导归档。
2. 硬删除时，后端删除数据库记录。
3. 同步清理关联的：
   - 缩略图缓存
   - 导出缓存
   - 本地化素材

## Version Control Model

### 草稿

1. 文档始终存在一份当前草稿。
2. 自动保存只覆盖草稿。
3. 自动保存不生成历史版本。

### 手动快照

1. 用户点击“保存版本”时创建 `drawio_versions` 记录。
2. 版本记录不可变。
3. 版本号按文档内递增，例如 `v1`、`v2`、`v3`。

### 恢复

恢复旧版本时不直接覆盖历史版本，而是：

1. 选择某个历史版本。
2. 将该版本 XML 复制到当前草稿。
3. 草稿更新后，用户再决定是否手动保存成一个新版本。

## Conflict Handling

采用乐观锁，不做悲观文件锁。

### 保存草稿流程

1. 前端打开文档时读取：
   - 草稿 XML
   - `current_draft_rev`
2. 前端保存草稿时带上 `expectedDraftRev`
3. 后端更新时执行：
   - `WHERE document_id = ? AND current_draft_rev = ?`
4. 成功则：
   - 覆盖草稿
   - `current_draft_rev + 1`
5. 若更新行数为 0，则返回 `409 conflict`

### 冲突返回结构

冲突时返回：

- `currentDraftRev`
- `serverUpdatedAt`
- `latestVersionId`
- `message`

前端提供三个动作：

1. 刷新最新草稿
2. 复制当前本地 XML 并另存为新文档
3. 查看本地与服务端 XML 差异

### 版本冲突原则

1. 草稿可以冲突。
2. 手动保存版本时如果草稿已经落后，也必须先提示冲突。
3. 不做自动合并 XML。

## Thumbnail Strategy

### 原则

缩略图全部视为可重建缓存。

### 生成时机

1. 新建文档后首次保存草稿时生成草稿缩略图。
2. 每次手动保存版本时生成版本缩略图。
3. 图库列表发现缩略图缺失时，标记为 `missing` 并触发后台重建。

### 存储格式

第一阶段默认使用：

- `SVG`

原因：

1. 流程图、架构图清晰度高。
2. 体积通常较小。
3. 适合图库卡片展示。

### 丢失与重建

若缩略图文件不存在：

1. 不影响文档读取。
2. 列表显示占位图。
3. 后台异步重建。

### 失败策略

若因外链图片超时、第三方拒绝访问、私网拦截或导出失败导致缩略图生成失败：

1. 文档保存成功。
2. 缩略图状态置为 `failed`。
3. 记录错误摘要。
4. 允许用户手动触发重建。

## External Asset Policy

第一阶段允许外链图片。

但系统必须明确以下边界：

1. 外链图片不阻止保存草稿。
2. 外链图片不保证缩略图一定成功。
3. 外链图片不保证导出 SVG 一定完全自包含。
4. 系统必须在右侧信息面板显示：
   - 外链数量
   - 外链域名摘要
   - 最近扫描时间
5. 后台渲染默认禁止访问私网与本机地址。

对于主动上传并本地化的图片素材：

1. 文件落到 `data/drawio/assets/`
2. 数据库存 `drawio_assets`
3. XML 中可替换为系统内受控地址

## Performance & Resource Requirements

这是该模块是否“好用”的核心边界，必须明确。

### 访问速度

1. 编辑器资源放在 `public/vendor/drawio/`，不打进主应用 JS bundle。
2. `DrawioPage` 按需懒加载，未进入模块时不加载编辑器资源。
3. 首次进入模块时允许有一次 iframe 初始化开销，但之后同会话内应尽量复用。

### 软件体积

1. 官方编辑器静态资源作为独立 vendor 目录发布。
2. 不把 draw.io 源码编译进 Vite 主入口。
3. 不新增大型前端图形依赖库。

### 内存占用

1. 前端常驻内存中只保留当前编辑文档 XML。
2. 图库列表不缓存所有文档 XML。
3. 后台离线渲染执行器默认并发数保持低值，例如 `1` 或 `2`。

### 列表页性能要求

图库列表 API 默认不返回：

1. `xml_content`
2. 大体积资源列表
3. 历史版本正文

列表页只返回：

1. 标题
2. 更新时间
3. 标签
4. 页数
5. 缩略图路径和状态
6. 最近版本号

### 自动保存要求

1. 自动保存必须 `debounce`，默认 `2000ms`。
2. 若 `xml_hash` 未变化，则不写数据库。
3. 自动保存一次只更新 `drawio_drafts` 和 `drawio_documents`。
4. 自动保存不创建版本。

### XML 大小约束

第一阶段要求：

1. 单文档 XML 支持常规 draw.io 图大小。
2. 默认限制 `5MB`，可在设置中调整。
3. 对极大文档给出 UI 警告。
4. 后端对导入体积和保存体积设置明确错误返回。

### SQLite 优化

1. 继续使用现有 SQLite + WAL 模式。
2. 历史版本查询必须按文档 ID 和时间索引。
3. 不对 XML 正文做全文检索。
4. 页信息、版本号和标签等列表字段做轻量冗余，避免列表页解析 XML。

## Functional Requirements

### 1. 新建与管理文档

用户必须能够：

1. 新建空白图文档。
2. 从 `.drawio` / `.xml` 导入文档。
3. 重命名文档。
4. 归档文档。
5. 删除文档。
6. 复制文档为新文档。

### 2. 编辑器宿主

用户必须能够：

1. 在宿主页中打开官方编辑器。
2. 加载当前草稿 XML。
3. 从编辑器取回当前 XML。
4. 手动保存草稿。
5. 手动保存版本。
6. 导出 `.drawio`、`.xml`、`.svg`。

### 3. 图库

图库必须支持：

1. 缩略图卡片视图。
2. 关键字搜索。
3. 标签筛选。
4. 最近编辑排序。
5. 按归档状态筛选。

### 4. 版本

版本视图必须支持：

1. 查看版本号。
2. 查看版本创建时间。
3. 查看版本备注。
4. 预览历史缩略图。
5. 恢复某个版本到草稿。

### 5. 设置

设置页必须支持：

1. 自动保存开关。
2. 自动保存间隔。
3. 默认导出格式。
4. 文档大小限制。
5. 版本提醒阈值。
6. 外链图片开关。
7. 私网外链拦截开关。
8. 缩略图默认格式和尺寸。

## API Contract

### 文档列表

- `GET /api/drawio/documents`
  - 查询参数：`q`、`tag`、`archived`、`sort`

### 新建文档

- `POST /api/drawio/documents`
  - body：`title`、`description`、`tags`

### 读取文档元数据

- `GET /api/drawio/documents/{id}`

### 更新文档元数据

- `PUT /api/drawio/documents/{id}`
  - body：`title`、`description`、`tags`、`archived`

### 删除文档

- `DELETE /api/drawio/documents/{id}`

### 克隆文档

- `POST /api/drawio/documents/{id}/clone`

### 读取草稿

- `GET /api/drawio/documents/{id}/draft`

### 保存草稿

- `PUT /api/drawio/documents/{id}/draft`
  - body：`xmlContent`、`expectedDraftRev`、`editorState`

### 保存版本

- `POST /api/drawio/documents/{id}/versions`
  - body：`summary`、`expectedDraftRev`

### 版本列表

- `GET /api/drawio/documents/{id}/versions`

### 版本详情

- `GET /api/drawio/documents/{id}/versions/{versionId}`

### 恢复版本到草稿

- `POST /api/drawio/documents/{id}/versions/{versionId}/restore`

### 导入

- `POST /api/drawio/import`
  - form-data：`file`

### 导出

- `GET /api/drawio/documents/{id}/export?format=drawio|xml|svg&source=draft|version&versionId=`

### 重建缩略图

- `POST /api/drawio/documents/{id}/thumbnails/rebuild`
- `POST /api/drawio/thumbnails/rebuild`

### 渲染任务查询

- `GET /api/drawio/render-jobs`

### 模块设置

- `GET /api/drawio/settings`
- `PUT /api/drawio/settings`

## Migration & Rollout Decisions

### Schema 初始化方式

沿用当前 Go 后端模块习惯：

1. 在 `drawio` service 初始化时执行 `CREATE TABLE IF NOT EXISTS`。
2. 使用动态列检查补齐后续新增字段。
3. 使用现有 schema lock，避免多实例重复迁移。

### 交付顺序

建议拆成三个里程碑：

1. `M1`
   - 模块接入
   - iframe 编辑器宿主
   - 文档 CRUD
   - 草稿保存
   - 基础导入导出
2. `M2`
   - 版本快照
   - 图库缩略图
   - 冲突处理
   - 设置页
3. `M3`
   - 后台离线重建
   - 外链安全拦截
   - 本地化素材
   - 备份接入

## Risks & Mitigations

### 1. iframe 风格与站点不一致

缓解方式：

1. 宿主页承担全部工具栏、侧栏、弹窗与状态 UI。
2. iframe 只承担画布与编辑器本体。
3. 使用 editor config 对齐主题。

### 2. 缩略图后台重建难度高

缓解方式：

1. 统一使用官方导出能力，不自研渲染器。
2. 在线导出优先，后台重建兜底。
3. 渲染失败不影响主数据保存。

### 3. 外链图片引入 SSRF 风险

缓解方式：

1. 后台渲染只允许 `http` / `https`。
2. 默认阻断私网、本机和保留地址。
3. 对被阻断资源只做缩略图降级，不拒绝保存 XML。

### 4. 大 XML 造成页面卡顿

缓解方式：

1. 列表页不返回 XML。
2. 自动保存做 `debounce` 和 `xml_hash` 去重。
3. 对大文档设置体积限制和前端提示。

### 5. 本地化素材遗漏备份

缓解方式：

1. PRD 明确 `drawio/assets/` 属于用户数据。
2. 后续备份实现必须纳入该目录。

## Testing Decisions

### 后端测试

必须覆盖：

1. XML 导入与归一化。
2. 压缩页解压。
3. 多页文档元数据提取。
4. 草稿保存。
5. 乐观锁冲突返回 `409`。
6. 手动快照创建。
7. 历史版本恢复到草稿。
8. 缩略图状态更新。
9. 外链资源提取。
10. 路由治理与 server dispatch。

### 前端测试

至少验证：

1. 模块可直接访问 `/drawio` 不白屏。
2. 图库加载、空态和错误态正常。
3. iframe 可加载自托管编辑器。
4. 草稿保存状态可见。
5. 冲突提示可见。
6. 导入和导出按钮可工作。
7. 版本列表可显示并恢复。
8. 多页文档可正常打开并保留封面页信息。

### 集成测试

建议补充：

1. 自托管编辑器页面可被同源 iframe 正常加载。
2. `/vendor/drawio/` 的安全头例外只影响 vendor 路径。
3. 批量缩略图重建任务不会阻塞普通保存接口。

### 验收命令

至少运行：

```bash
npm run audit:fast
npm run backend-go:test
node tools/backend-route-inventory.mjs
```

涉及后端运行态时，再执行：

```bash
npm run backend-go:smoke
```

## Acceptance Criteria

1. 侧边栏出现 `图编辑器` 模块，位于 `工具箱 -> 实用工具`。
2. 页面包含 `主界面`、`图库`、`版本`、`设置` 四个顶层 Tab。
3. 用户可以导入 `.drawio` 和 `.xml` 文件。
4. 用户可以在页面中打开官方编辑器并编辑图。
5. 当前草稿 XML 存入数据库，且不会自动产生历史版本。
6. 用户点击“保存版本”后会生成不可变快照。
7. 版本恢复会更新草稿，而不是修改历史版本本身。
8. 草稿保存发生冲突时返回 `409`，并可在前端看到明确提示。
9. 图库列表默认不加载 XML 正文，列表性能不依赖大 XML 返回。
10. 多页 draw.io 文档可以作为单个文档正常保存与打开。
11. 缩略图丢失后不会影响文档打开，并能通过任务重建。
12. 允许外链图片，但外链失败或被后台安全策略拦截时不能阻止保存与版本化。
13. `/vendor/drawio/` 静态资源可被主站 iframe 嵌入，而其他业务页面仍保持现有安全头策略。
14. 本地化素材保存到 `data/drawio/assets/`，并被定义为后续备份范围。

## Out of Scope

1. 公开页。
2. 用户管理。
3. 团队协作。
4. AI 自动生成和修改。
5. 实时协作与合并。
6. Git 风格分支和 patch 级版本系统。
