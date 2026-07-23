# Oracle OCI 主机管理模块 PRD

最后更新：2026-07-12

## Problem Statement

当前 API Monitor 已覆盖 Cloudflare、阿里云、腾讯云、Koyeb、Fly.io、Microsoft 365，以及自有主机与 Agent 管理能力，但仍缺少 Oracle Cloud Infrastructure（OCI）这一类高频自托管与低成本出海场景常见的云厂商支持。

这带来几个明显问题：

1. 使用 OCI 的用户需要在 Oracle 控制台、CLI、SDK 示例项目和 API Monitor 之间来回切换，无法在一个统一面板里管理实例。
2. 现有 `server` 模块偏向“已纳管主机”的 SSH、Agent、Docker、监控和文件操作，不适合直接承担“云资源编排”的职责。
3. 项目虽然已经有阿里云、腾讯云模块，但尚未形成一套基于 Oracle 官方 SDK 的 OCI 资源接入方案。
4. 目前用户无法在 API Monitor 中查看 OCI 实例、执行开关机/重启/终止、查看 VNIC 与 IP、查看卷附加情况、生成控制台连接。
5. 项目对云厂商凭证的存储策略并不完全一致，Oracle 模块需要从第一版开始建立更稳妥的加密存储和审计基线。

用户真正需要的不是“把 OCI 文档链接放进系统”，而是一个基于 **Oracle 官方 SDK** 的、与现有云厂商模块风格一致的、可继续扩展的 OCI 主机管理能力。

## Goals

1. 在 API Monitor 中新增一个独立的 `oracle` 模块，作为 OCI 云厂商入口。
2. 使用 **Oracle 官方 SDK** 实现 OCI 资源管理，避免手写请求签名和底层 REST 细节。
3. 第一阶段覆盖“实例管理”主路径：账号接入、实例列表、实例详情、生命周期动作、网络/IP、卷附加、控制台连接。
4. 保持与现有 Go Manifest 后端、React + Kumo 前端、SQLite 数据层和模块治理方式一致。
5. 让 Oracle 模块具备后续扩展到镜像、形状、启动实例、配额/容量、实例配置的能力。

## Non-Goals

1. 第一版不将 OCI 实例自动接入现有 `server` 模块的 Agent、SSH、Docker、SFTP 体系。
2. 第一版不实现 OCI 全产品覆盖，不扩展到负载均衡、对象存储、数据库、Functions、OKE 等非主机资源。
3. 第一版不做多租户 RBAC，也不提供细粒度的模块内权限模型。
4. 第一版不做 Terraform、Ansible、Pulumi 级别的 IaC 编排能力。
5. 第一版不支持通过浏览器直接上传巨大的私钥文件或管理复杂证书链。

## Target Users

1. 使用 OCI VM/裸金属实例的个人用户和小团队运维者。
2. 希望在一个统一面板中管理多云实例资源的自托管用户。
3. 已经使用 API Monitor 管理阿里云、腾讯云、Cloudflare，同时新增 OCI 资产的用户。
4. 使用 Oracle 免费层、低成本 ARM 实例、出海节点或中小型业务服务器的管理员。

## Success Metrics

1. 用户可以在 5 分钟内完成一个 OCI 账号接入并看到实例列表。
2. 用户可以在 UI 中成功对 OCI 实例执行启动、停止、重启操作。
3. 用户可以在实例详情中看到公网 IP、私网 IP、VNIC 附加、引导卷/数据卷附加信息。
4. 用户可以创建或查看实例控制台连接，并复制连接信息。
5. 模块接入后不破坏现有 Go manifest、前端模块导航和审计命令。
6. Oracle 模块敏感凭证默认使用现有 `secure` 能力加密存储。

## Solution

新增一个独立的 Oracle 云厂商模块，模块 ID 为 `oracle`，入口名称建议为“甲骨文云”或“Oracle Cloud”，位于前端侧边栏“云服务 -> 云厂商”分组中。

模块采用与阿里云、腾讯云模块相似的产品形态，但在后端实现上明确使用 **Oracle 官方 SDK**：

1. 前端新增 `OraclePage.jsx`，提供账号管理、实例列表、实例详情和相关子视图。
2. 后端新增 `backend-go/internal/oracle/`，作为 OCI SDK 封装与 HTTP service 入口。
3. 路由统一使用 `/api/oracle/...` 前缀，并登记到 `manifest.go`。
4. 模块默认只处理 OCI 云资源，不侵入现有 `serveragent` 的 SSH/Agent 实时控制链路。
5. 对于创建实例、终止实例等高风险操作，采用 Kumo 删除确认或明确二次确认流程。

## Product Scope

### Phase 1：账号接入与实例管理主链路

- OCI 账号配置与验证
- 实例列表
- 实例详情
- 启动、停止、重启、软关机等生命周期动作
- 终止实例
- 查看 VNIC 附加与 IP 信息
- 查看引导卷与数据卷附加
- 控制台连接查看/创建/删除

### Phase 2：启动实例与资源选择器

- 列出 compartment
- 列出 availability domain
- 列出 subnet / VCN
- 列出 image / shape
- 启动实例
- 基础容量检查

### Phase 3：和现有主机模块建立弱集成

- 将 OCI 实例信息导入到 `server` 模块表单草稿
- 从 OCI 实例预填主机名、IP、区域、备注
- 可选的一键生成 Agent 安装命令指引

## User Stories

1. 作为管理员，我想新增一个 OCI 账号，以便在系统中管理 Oracle 云资源。
2. 作为管理员，我想验证账号配置是否有效，以便尽早发现 region、租户或密钥错误。
3. 作为管理员，我想看到账号默认 region 和默认 compartment，以便减少重复选择。
4. 作为管理员，我想查看某个 compartment 下的实例列表，以便快速定位目标机器。
5. 作为管理员，我想按实例名称、状态、可用域和公网 IP 搜索实例，以便在实例较多时快速筛选。
6. 作为管理员，我想看到实例的公网 IP 和私网 IP，以便进行连接和资产登记。
7. 作为管理员，我想查看实例形状、镜像、可用域、创建时间和电源状态，以便判断实例用途。
8. 作为管理员，我想对实例执行启动操作，以便恢复停机资源。
9. 作为管理员，我想对实例执行停止或软停止操作，以便节约资源或进行维护。
10. 作为管理员，我想对实例执行重启操作，以便完成系统级恢复。
11. 作为管理员，我想终止某个无用实例，以便减少费用，但在执行前希望看到明确风险提示。
12. 作为管理员，我想查看实例附加的 VNIC 列表，以便了解网络接口和子网关系。
13. 作为管理员，我想查看实例的引导卷和数据卷附加，以便排查磁盘挂载问题。
14. 作为管理员，我想查看或创建控制台连接，以便在 SSH 不可用时进入串口控制台排障。
15. 作为管理员，我想在一个详情页里集中查看实例、网络和存储摘要，而不是来回跳转。
16. 作为管理员，我想在账号维度配置默认 compartment 和常用筛选条件，以便减少重复操作。
17. 作为管理员，我想在失败时看到 OCI SDK/接口返回的具体错误摘要，以便快速修正配置。
18. 作为管理员，我想让所有高风险操作都写入操作日志，以便后续审计。
19. 作为管理员，我想后续可以从 OCI 实例一键导入到 `server` 模块，以便继续纳管 Agent/SSH。
20. 作为管理员，我想整个模块 UI 与现有云厂商模块一致，并且全部使用中文，以便降低学习成本。

## Functional Requirements

### 1. 模块入口与导航

- 新增模块 ID：`oracle`
- 前端导航文案建议：`甲骨文云`
- 分组位置：`云服务 -> 云厂商`
- 路由路径：`/oracle`
- 页面文件：`src/js/pages/OraclePage.jsx`

### 2. OCI 账号管理

模块必须支持 OCI 账号的新增、编辑、删除、验证和列表展示。

建议支持的字段：

- `name`：账号备注名
- `tenancyOcid`
- `userOcid`
- `fingerprint`
- `region`
- `privateKeyPem`
- `passphrase`（可选）
- `defaultCompartmentId`（可选）
- `description`（可选）

规则：

- 私钥和 passphrase 必须加密存储。
- 私钥不应在列表页明文回显。
- 编辑账号时允许“不修改私钥则留空”。
- 验证账号时至少验证 SDK 是否可初始化，以及是否能调用基础只读接口。
- 列表页展示备注名、region、默认 compartment、创建时间、最后验证时间和最后验证结果。

### 3. Compartment 与基础选择器

- 支持读取 OCI compartments 列表。
- 支持选择当前查询的 compartment。
- 默认使用账号配置中的 `defaultCompartmentId`，未设置时提示用户选择。
- 支持基础缓存，减少重复请求。
- 查询实例时必须显式带上 compartment 上下文。

### 4. 实例列表

实例列表是第一阶段最核心的页面能力。

至少展示以下字段：

- 实例名称
- `instanceId`
- lifecycle state
- shape
- availability domain
- region
- 公网 IP
- 私网 IP
- 创建时间
- image 名称或 imageId

能力要求：

- 支持按实例名关键字搜索。
- 支持按状态筛选，例如 `RUNNING`、`STOPPED`、`PROVISIONING`、`TERMINATED`。
- 支持刷新实例列表。
- 支持按卡片视图或表格视图展示，优先复用现有云厂商模块风格。
- 空状态、加载态、失败态必须清晰可读。

### 5. 实例详情

实例详情页或实例详情弹层至少应包含：

- 基础信息
- 电源与生命周期状态
- 可用域 / fault domain
- shape
- image
- metadata 摘要
- 主 VNIC 与附加 VNIC 摘要
- 引导卷与数据卷附加摘要
- 创建时间和状态更新时间

详情页应作为网络、卷和控制台连接的统一入口。

### 6. 实例生命周期动作

第一阶段支持以下实例动作：

- `START`
- `STOP`
- `SOFTSTOP`
- `RESET`
- `SOFTRESET`
- `REBOOTMIGRATE`（可在高级菜单中暴露）
- `TERMINATE`

规则：

- 高风险动作必须有明确确认文案。
- `TERMINATE` 必须使用更强确认，提示是否保留引导卷/数据卷。
- 动作执行后要有 toast 反馈，并触发列表/详情刷新。
- 若 OCI 返回 work request 或异步状态，前端应显示“指令已下发”而非假定操作已完成。

### 7. 网络与 VNIC 信息

实例详情中必须支持查看：

- 主 VNIC
- 所有 VNIC attachments
- VNIC 所在 subnet
- 私网 IP
- 公网 IP
- 是否主网卡
- NIC 状态

后端可按 OCI 官方推荐路径查询：

1. 列实例 VNIC attachment
2. 再获取对应 VNIC 详情

### 8. 卷附加信息

实例详情中必须支持查看：

- Boot volume attachments
- Block volume attachments
- 附加类型
- 设备路径
- 是否只读
- 状态

第一阶段只要求查看，不要求在 UI 中执行挂载/卸载卷动作。

### 9. 控制台连接

模块必须支持：

- 查看实例已有 console connection
- 创建 console connection
- 删除 console connection
- 展示 connection string / 指引信息

规则：

- 控制台连接属于排障能力，应放在详情页的“控制台”子区域。
- 删除和重建连接都要有确认。
- 不在浏览器内实现原生控制台终端，只管理连接资源与复制信息。

### 10. 启动实例（第二阶段）

为了避免第一阶段过大，启动实例可置于第二阶段，但 PRD 先定义范围：

- 选择 compartment
- 选择 availability domain
- 选择 shape
- 选择 image
- 选择 subnet
- 选择 SSH key / metadata
- 配置名称和基础网络参数

第二阶段不要求覆盖 OCI 所有高级创建参数，但要保留可扩展的数据模型。

## UX Requirements

1. 页面主体风格应和 `AliyunPage`、`TencentPage` 保持一致。
2. 账号管理与实例管理放在同一个 Oracle 页面内，用 Tabs 分区。
3. 推荐首批 Tabs：
   - `实例`
   - `网络`
   - `卷`
   - `控制台`
   - `账号管理`
4. 也允许采用“实例列表 + 右侧详情”的双栏设计，但应优先控制实现复杂度。
5. 所有可见文案使用中文。
6. 所有按钮、表格、弹窗、下拉、通知使用 Kumo 组件。
7. 删除或终止动作优先使用 `DeleteResource` 风格确认。
8. 账号表单中私钥输入区要支持多行文本。
9. 对长 OCID、IP、console string 应支持复制。
10. 错误信息应尽量把 OCI 返回消息转成“简短中文摘要 + 原始错误详情”。

## Technical Design Principles

### 1. 后端必须使用 Oracle 官方 SDK

- 不手写 OCI 请求签名。
- 不自己实现底层 REST 客户端作为主路径。
- SDK 作为后端唯一主通道，必要时可保留极小量补充 HTTP 能力，但不能成为主实现。

### 2. 模块必须走现有 Go Manifest 架构

- 路由注册到 `backend-go/internal/manifest/manifest.go`
- 在 `backend-go/internal/server/server.go` 中装配和分发
- 鉴权模式默认 `AuthSession`
- 不新增 Express sidecar 或独立微服务

### 3. 数据持久化仍使用 SQLite

建议表：

#### `oracle_accounts`

- `id`
- `name`
- `tenancy_ocid`
- `user_ocid`
- `fingerprint`
- `region`
- `private_key_encrypted`
- `passphrase_encrypted`
- `default_compartment_id`
- `description`
- `last_verified_at`
- `last_verify_status`
- `last_verify_error`
- `created_at`
- `updated_at`

#### `oracle_saved_views`（可选）

- 保存常用筛选、默认 tab、默认 compartment

第一阶段不要求落库缓存实例列表，实例数据可实时查询。

### 4. 凭证必须加密存储

- `private_key_encrypted` 和 `passphrase_encrypted` 必须使用现有 `secure` 包。
- 禁止明文保存 Oracle 私钥。
- 账号读取到 SDK client 前再临时解密。

### 5. 模块内部按职责拆分

推荐目录：

```text
backend-go/internal/oracle/
├── service.go
├── types.go
├── schema.go
├── account_store.go
├── client_factory.go
├── compute_service.go
├── network_service.go
├── storage_service.go
├── console_service.go
└── service_test.go
```

不建议把所有 OCI 逻辑堆进一个超大 `service.go`。

## API Contract Draft

### 账号

- `GET /api/oracle/accounts`
- `POST /api/oracle/accounts`
- `PUT /api/oracle/accounts/{id}`
- `DELETE /api/oracle/accounts/{id}`
- `POST /api/oracle/accounts/{id}/verify`

### 基础资源

- `GET /api/oracle/accounts/{id}/compartments`
- `GET /api/oracle/accounts/{id}/availability-domains`
- `GET /api/oracle/accounts/{id}/shapes`
- `GET /api/oracle/accounts/{id}/images`
- `GET /api/oracle/accounts/{id}/subnets`

### 实例

- `GET /api/oracle/accounts/{id}/instances`
- `GET /api/oracle/accounts/{id}/instances/{instanceId}`
- `POST /api/oracle/accounts/{id}/instances/{instanceId}/actions`
- `DELETE /api/oracle/accounts/{id}/instances/{instanceId}`
- `POST /api/oracle/accounts/{id}/instances`

### 网络 / 卷 / 控制台

- `GET /api/oracle/accounts/{id}/instances/{instanceId}/vnic-attachments`
- `GET /api/oracle/accounts/{id}/instances/{instanceId}/boot-volume-attachments`
- `GET /api/oracle/accounts/{id}/instances/{instanceId}/volume-attachments`
- `GET /api/oracle/accounts/{id}/instances/{instanceId}/console-connections`
- `POST /api/oracle/accounts/{id}/instances/{instanceId}/console-connections`
- `DELETE /api/oracle/accounts/{id}/console-connections/{connectionId}`

### 可选异步状态

- `GET /api/oracle/accounts/{id}/work-requests/{workRequestId}`

## Request / Response Requirements

统一遵循项目现有响应风格：

成功：

```json
{
  "success": true,
  "data": {}
}
```

失败：

```json
{
  "success": false,
  "error": "错误描述",
  "code": "OCI_ERROR"
}
```

额外要求：

- 列表接口应尽量返回标准化字段，而不是直接把 OCI SDK 原对象生硬透传到前端。
- 但为了调试和后续扩展，可以在详情接口中保留 `raw` 或 `source` 的受控摘要字段。

## Security Requirements

1. Oracle 账号相关所有接口均要求 session auth。
2. 私钥与 passphrase 必须加密存储。
3. 日志和错误信息不得打印完整私钥内容。
4. 账号列表不回显敏感字段。
5. 终止实例、创建控制台连接、删除控制台连接等高风险操作需要明确确认。
6. 后端要为关键动作写入现有操作日志体系。
7. 文档、示例和测试夹具不得写入真实 OCID、真实私钥和真实 region/网络信息。

## Integration Decisions

1. **不直接并入 `server` 模块**
   原因：`server` 模块是主机纳管与实时操作中心，Oracle 模块是云资源控制面，职责不同。

2. **前端先做独立 Oracle 页面**
   原因：复用现有阿里云、腾讯云模块范式，风险最小。

3. **后端使用独立 oracle service**
   原因：方便按 OCI 资源域拆分，不污染 `serveragent`。

4. **未来提供“导入到主机模块”弱集成**
   原因：OCI 实例后续可能需要继续做 SSH/Agent 管理，但不应作为第一阶段前置条件。

## Observability and Logging

模块至少需要记录以下行为：

- 新增/编辑/删除账号
- 验证账号
- 刷新实例列表
- 实例生命周期动作
- 控制台连接创建/删除

日志要求：

- 记录账号 ID、实例 ID、动作类型、结果状态、错误摘要
- 不记录私钥明文
- 失败时记录 OCI 返回的可诊断信息

## Testing Decisions

### 后端测试

- 账号 schema 初始化
- 凭证加解密
- SDK client 工厂初始化
- 路由分发
- 实例列表字段归一化
- 生命周期动作参数校验
- 控制台连接创建/删除逻辑
- 高风险动作错误分支

### 前端测试

- 账号表单校验
- 空态 / 加载态 / 失败态渲染
- 实例列表筛选
- 动作确认弹窗
- 详情页 Tab 切换

### 联调与验收

- `npm run governance:check`
- `node tools/backend-route-inventory.mjs`
- `npm run backend-go:test`
- `npm run lint`
- 浏览器 smoke：登录、进入 Oracle 页面、添加账号、查看实例、执行动作、打开详情

## Release Plan

### Milestone 1：架构接入

- 前端注册 `oracle` 模块
- 后端注册 `/api/oracle`
- 建立 SQLite schema
- 建立 SDK client 工厂

### Milestone 2：账号与基础读取

- 账号 CRUD
- 账号验证
- compartments 读取
- 基础页面空态与账号管理

### Milestone 3：实例管理

- 实例列表
- 实例详情
- 实例启动/停止/重启
- 终止实例

### Milestone 4：网络 / 卷 / 控制台

- VNIC attachments
- Boot volume attachments
- Block volume attachments
- Console connections

### Milestone 5：启动实例与体验完善

- 启动实例表单
- image / shape / subnet 选择器
- 默认筛选保存
- 更好的错误提示与操作日志

## Acceptance Criteria

1. 侧边栏中可以看到 `甲骨文云` 模块入口。
2. 用户可以成功新增一个 OCI 账号，并通过“验证账号”得到明确反馈。
3. 用户可以在指定 compartment 下看到实例列表。
4. 实例列表中可见状态、形状、可用域、公网 IP、私网 IP 等核心字段。
5. 用户可以对实例执行启动、停止、重启。
6. 用户可以终止实例，并在操作前看到清晰确认。
7. 用户可以查看实例的 VNIC 附加信息。
8. 用户可以查看实例的引导卷与数据卷附加信息。
9. 用户可以查看、创建和删除控制台连接。
10. 账号私钥不会以明文形式持久化到数据库。
11. 所有 `/api/oracle` 接口都进入 manifest 和 Go route 分发体系。
12. 页面使用 Kumo 组件，中文 UI 完整，无明显样式漂移。
13. 相关测试和治理命令通过。

## Risks

1. OCI SDK 资源模型较多，若直接把原始类型暴露到前端，后续会变得难维护。
2. OCI 某些动作是异步的，若前端把“请求成功”误认为“资源已完成变更”，会造成误解。
3. compartment、subnet、image、shape 选择链路较长，若第一版尝试一次做全，复杂度会快速膨胀。
4. 若沿用现有部分云厂商模块的明文凭证存储模式，会引入新的安全债务。
5. 若强行把 Oracle 做进 `server` 模块，会混淆“云资源管理”和“已纳管主机管理”边界。

## Out of Scope

1. OKE、LB、Object Storage、DB System、Functions 等非实例核心资源。
2. 自动将 OCI 实例注册进 `server_accounts`。
3. 实例挂载/卸载卷的高级写操作。
4. 浏览器内直接嵌入 Oracle 串口控制台。
5. 多账号之间的细粒度协作权限。

## Further Notes

1. Oracle 模块是当前项目最适合借机建立“SDK 优先、凭证加密、资源归一化”的新模板。
2. 如果该模块落地顺利，后续也可反向推动阿里云、腾讯云模块的凭证存储和 service 拆分治理。
3. 第一版应优先把“看得到、控得住、报错清楚”做好，再扩展到创建实例等复杂编排能力。
