# DevOps GitHub 仓库观察模块 PRD

最后更新：2026-07-15

## Problem Statement

API Monitor 已覆盖主机、云服务、可用性监测、定时任务、通知和 API 网关，但缺少面向代码仓库与 CI/CD 的统一观察入口。用户需要在同一个运维面板中添加 GitHub 仓库，持续观察仓库增长、协作活动、Actions 状态、流量数据和关键事件，并在异常出现时复用现有通知渠道及时告警。

该模块必须同时支持公开仓库和私有仓库，支持粘贴 GitHub URL 自动解析，支持后台定时采集和历史留存，并允许管理员在受控条件下对仓库或 Actions 执行操作。

## Solution

新增 DevOps 分组，并在该分组下新增 GitHub 模块。模块 ID 为 `github`，后端 API 入口为 `/api/github`。

GitHub 模块提供四类能力：

1. 仓库观察：添加公开/私有仓库，展示 stars、forks、watchers、issues、PR、release、commit 活跃度、Actions 状态、traffic views/clones、contributors。
2. 趋势分析：保存后台采集快照，展示 star 增长曲线、Actions 成功率、最近提交频率、issue/PR 增减。
3. 事件与通知：将 Action 失败、Action 恢复成功、新 release、star 激增、issue/PR 新增、仓库不可访问、token 失效、rate limit 过低等事件接入现有通知模块。
4. 受控操作：允许在具备权限时执行重新运行 workflow、重跑失败 jobs、取消 workflow、触发 workflow dispatch、同步仓库、测试 token、刷新仓库数据等操作，并记录审计日志。

所有可见 UI 使用中文，基础 UI 使用 Kumo 组件。数据持久化继续使用 SQLite。敏感 Token 使用现有 secure 加密能力存储。

## Feasibility Assessment

| 能力 | GitHub API 支持 | 说明 |
|---|---|---|
| 公开仓库基础信息 | 支持 | 不带 token 也可读，但 rate limit 很低。 |
| 私有仓库基础信息 | 支持 | 需要 token 对目标仓库有读取权限。 |
| stars/forks/watchers | 支持 | 仓库接口返回主要计数字段；watchers 口径按 GitHub API 字段展示。 |
| issue/PR 数量与变化 | 支持 | 第一版使用 REST 搜索和快照差值统计。 |
| release | 支持 | 可读 latest release；新 release 可由轮询或 webhook 触发。 |
| commit 活跃度 | 支持 | 第一版采集近 30 天 commits 数量。 |
| Actions 状态 | 支持 | 可读取 workflow runs，并支持 rerun/cancel/dispatch 操作。 |
| traffic views/clones | 支持但受限 | 通常要求对仓库有较高权限；GitHub 只保留短期 traffic 数据，因此必须后台采集入库。 |
| contributors | 支持 | REST contributors 可读；大仓库需要分页深化。 |
| star 增长曲线 | 支持 | 第一版以本地采集快照为准。 |
| webhook | 支持 | GitHub webhook 是 HTTP 回调，不是长连接；应用内实时展示使用 SSE。 |

## User Stories

1. 作为管理员，我想在 DevOps 分组中打开 GitHub 模块，以便集中查看代码仓库和 CI/CD 状态。
2. 作为管理员，我想粘贴 GitHub 仓库 URL，以便系统自动解析 owner/repo。
3. 作为管理员，我想添加公开仓库，以便观察开源项目的 star、fork、release 和 Actions 状态。
4. 作为管理员，我想添加私有仓库，以便观察自己的私有项目。
5. 作为管理员，我想配置 GitHub Token，以便读取私有仓库和高权限指标。
6. 作为管理员，我想测试 token 权限，以便知道哪些指标和操作可用。
7. 作为管理员，我想看到仓库卡片上的 stars、forks、watchers、issues、PR、latest release 和默认分支，以便快速判断仓库状态。
8. 作为管理员，我想看到 Actions 最新运行状态，以便及时发现 CI/CD 失败。
9. 作为管理员，我想查看 workflow runs 列表，以便追踪每次构建的分支、提交、触发者、耗时和结论。
10. 作为管理员，我想查看 Actions 成功率趋势，以便判断构建稳定性是否下降。
11. 作为管理员，我想查看 star 增长曲线，以便判断项目关注度变化。
12. 作为管理员，我想查看最近提交频率，以便判断项目活跃度。
13. 作为管理员，我想查看 issue/PR 增减趋势，以便判断维护压力。
14. 作为管理员，我想查看 traffic views/clones，以便了解仓库访问和克隆情况。
15. 作为管理员，我想查看 contributors，以便了解主要贡献者和贡献集中度。
16. 作为管理员，我想配置每个仓库的采集间隔，以便平衡实时性和 GitHub rate limit。
17. 作为管理员，我想配置数据保留周期，以便控制 SQLite 数据体积。
18. 作为管理员，我想在 Action 失败时收到通知，以便第一时间处理构建故障。
19. 作为管理员，我想在失败的 Action 恢复成功时收到通知，以便知道故障已解除。
20. 作为管理员，我想在有新 release 时收到通知，以便跟进版本发布。
21. 作为管理员，我想在 star 激增时收到通知，以便发现异常传播或增长机会。
22. 作为管理员，我想在 issue/PR 新增时收到通知，以便及时处理协作入口。
23. 作为管理员，我想在仓库不可访问时收到通知，以便发现 token 失效、权限变更或仓库删除。
24. 作为管理员，我想在 token 失效时收到通知，以便恢复私有仓库采集。
25. 作为管理员，我想在 rate limit 过低时收到通知，以便调整采集策略。
26. 作为管理员，我想启用 GitHub webhook，以便关键事件不必等待下一轮轮询。
27. 作为管理员，我想在页面中实时看到 webhook/采集事件，以便快速确认模块正在工作。
28. 作为管理员，我想重新运行失败的 workflow run，以便快速恢复 CI/CD。
29. 作为管理员，我想取消正在运行的 workflow run，以便停止错误构建。
30. 作为管理员，我想触发 workflow dispatch，以便手动启动部署或检查流程。

## Implementation Decisions

- 模块 ID 使用 `github`。
- 导航新增 `devops` 分组，中文名“DevOps”，模块列表包含 `github`。
- 后端新增 GitHub service，内部拆分 client、store、collector、webhook、event evaluator、operation runner。
- GitHub API client 封装 token、rate limit、分页入口、REST API version 和错误归一化。
- Collector 封装采集计划、失败隔离、快照写入和事件生成。
- Event evaluator 根据前后状态差异产生通知事件。
- Webhook receiver 只负责验签、去重、事件入库和触发增量刷新，不直接承担全部趋势计算。
- 操作 runner 负责 Actions 操作，统一做权限检查、结果归一化和审计记录。
- 通知通过现有 notification service 触发，不新增通知渠道。
- 前端页面包含仓库、Actions、趋势、事件、设置五个视图。

## API Contract

- `GET /api/github`
- `GET /api/github/tokens`
- `POST /api/github/tokens`
- `PUT /api/github/tokens/{id}`
- `DELETE /api/github/tokens/{id}`
- `POST /api/github/tokens/{id}/test`
- `GET /api/github/repositories`
- `POST /api/github/repositories`
- `GET /api/github/repositories/{id}`
- `PUT /api/github/repositories/{id}`
- `DELETE /api/github/repositories/{id}`
- `POST /api/github/repositories/parse-url`
- `POST /api/github/repositories/{id}/refresh`
- `GET /api/github/repositories/{id}/summary`
- `GET /api/github/repositories/{id}/trends`
- `GET /api/github/repositories/{id}/actions/runs`
- `GET /api/github/repositories/{id}/contributors`
- `GET /api/github/repositories/{id}/traffic`
- `GET /api/github/repositories/{id}/events`
- `POST /api/github/repositories/{id}/actions/runs/{runId}/rerun`
- `POST /api/github/repositories/{id}/actions/runs/{runId}/rerun-failed-jobs`
- `POST /api/github/repositories/{id}/actions/runs/{runId}/cancel`
- `POST /api/github/repositories/{id}/actions/workflows/{workflowId}/dispatch`
- `POST /api/github/webhook/{repositoryId}`
- `POST /api/github/webhook`
- `GET /api/github/events/stream`
- `GET /api/github/settings`
- `PUT /api/github/settings`
- `POST /api/github/collector/run`
- `GET /api/github/collector/status`
- `DELETE /api/github/history`

## Data Model

新增表使用 `github_` 前缀：

- `github_tokens`
- `github_repositories`
- `github_repository_snapshots`
- `github_action_runs`
- `github_traffic_samples`
- `github_contributors`
- `github_events`
- `github_webhook_deliveries`
- `github_operation_audit`
- `github_settings`

## Testing Decisions

- GitHub URL parser 覆盖 HTTPS、SSH、带路径、尾斜杠、非法 URL。
- Webhook signature 覆盖有效签名和错误签名。
- 后端测试覆盖 GitHub 包编译、路由治理和全后端测试。
- 前端通过 lint 和 production build 验证页面、导航、图表和 Kumo 组件。

## Acceptance Criteria

- 侧边栏出现 DevOps 分组，包含 GitHub 模块。
- 用户可以粘贴 GitHub URL 添加公开仓库。
- 用户可以通过 token 添加私有仓库。
- 仓库列表展示 stars、forks、watchers、issues、PR、release、Actions 状态。
- 后端后台定时采集并保存历史快照。
- 页面展示 star 增长、Actions 成功率、提交频率、issue/PR 增减趋势。
- traffic views/clones 在权限足够时展示；权限不足时显示明确状态。
- Action 失败、恢复成功、新 release、star 激增、issue/PR 新增、仓库不可访问、token 失效、rate limit 过低能进入通知规则体系。
- webhook receiver 能验签并入库事件。
- 页面可以通过 SSE 接收实时事件流。
- 数据保留周期可全局配置并可仓库级覆盖。
- 允许操作 workflow run，并记录审计。
- 所有可见 UI 为中文。
- 新增 route 全部在 manifest 中登记。

## Out of Scope

- 不实现 GitHub Enterprise Server 专属兼容。
- 不做多租户权限隔离。
- 不承诺完全替代 GitHub 官方 Actions 页面。
- 不默认开放 issue/PR 写操作。
- 不依赖外部数据库或队列。
- 不把 webhook 当作唯一数据源，后台轮询仍是趋势和兜底来源。
