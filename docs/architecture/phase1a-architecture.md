# EvalBase Phase 1A 最小可交付技术架构

| 项目         | 内容                                       |
| ------------ | ------------------------------------------ |
| 状态         | Approved for Non-production Development    |
| 修订日期     | 2026-09-09                                 |
| 产品合同     | [EvalBase v1 PRD](../PRD-evalbase-v1.md)   |
| 用户交互合同 | `92cb8a5` / `prototype/solo-workflow-v5.3` |
| 正式前端     | `frontend-v3/`                             |

## 1. 架构边界

本架构只支撑冻结原型的用户动作，不定义额外产品功能。原型没有的页面、表单、CLI 或公共工作流不得由“后台能力”名义重新暴露。

允许保留的内部严谨性包括 PostgreSQL/MinIO 持久化、原始字节与哈希、流式容量、项目隔离、Origin/CSRF、幂等、稳定身份、原子发布、来源事实、安全 CSV、删除闭包、重试和审计。

## 2. 运行拓扑

```text
Owner browser
    |
    | HTTP :<WEB_PORT>
    v
Web (Fastify + frontend-v3 static build)
    |----------------------- internal Docker network ----------------------|
    v                                                                    v
PostgreSQL                                                         Worker
                                                                         |
                                                                         v
                                                                       MinIO
```

- Node.js 固定 major 24，包管理器为 npm。
- 一个专用 Compose project 使用专用内部 network、PostgreSQL database、MinIO bucket 和 named volumes。
- PostgreSQL、MinIO 和 Worker 不发布宿主机入站端口。
- Web 只绑定 Owner 已批准的非生产地址；不扩大暴露面。
- 当前无备份、RPO、RTO、SLA 或灾难恢复承诺。

## 3. 前端基线

1. `frontend-v1/` 是永久只读 donor。
2. `frontend-v2/` 是已废弃实验实现，只保留历史，不再开发、构建、部署或作为正式回滚目标。
3. Ticket 20 在固定 HEAD 完整复制 `frontend-v1/` 为 `frontend-v3/`。
4. `frontend-v3/` 保留 donor 的字体、样式、布局和通用组件，只替换业务和数据访问。
5. Ticket 27 验收后，正式静态构建和 Compose 只使用 `frontend-v3/`；`src/web/` 与 `frontend-v2/` 退出运行路径。

详细规则见 [Frontend Reuse](./phase1a-frontend-reuse.md)。

## 4. 数据职责

### 4.1 PostgreSQL

PostgreSQL 保存：

- 项目和唯一 Owner 请求身份；
- 数据集、固定“未整理”和文件归属；
- 待确认上传状态和浏览映射；
- 解析视图、原始记录定位和记录计数；
- 测试集、不可变版本、父边、版本标签、记录级 Delta 和关系表 Checkpoint；
- 来源、修改事实、回收站、墓碑与必要审计；
- 内部作业、租约、幂等键和提交标记引用。

### 4.2 MinIO

MinIO 保存：

- 待确认上传临时字节；
- 已确认原始文件；
- 可重建解析产物；
- 旧版本规范化字节和新版本的不可变 Delta manifest；
- 当前版本的 CSV 派生文件。

浏览器不取得 PostgreSQL/MinIO 凭据或长期对象 URL。

### 4.3 提交顺序

跨 PostgreSQL/MinIO 写入遵守 staging → 校验 → commit marker → 数据库可见状态。失败或取消只留下可回收临时对象，不留下用户可见半成品。

新测试集版本的存储格式、正式 schema、Delta manifest、Checkpoint 阈值和删除依赖切断由 [ADR-0011](../adr/0011-incremental-test-set-version-storage.md) 固定。现有完整成员版本保持 `legacy_full_v1`，不批量重写历史。

## 5. 深模块与公共接口

下列接口表达模块职责，不强制具体类名。

### 5.0 公共 API 适配规则

每张 Ticket 先盘点受影响路由、调用方和可复用深模块，再按以下顺序处理：

1. 现有公共路由与冻结原型完全一致时直接复用。
2. 现有路由包含多余请求参数、响应字段或动作，且没有其他现行合同调用方时，默认原位收紧到本节接口；旧前端、历史 Ticket 和旧测试不构成兼容理由。
3. 现有深模块可复用但 HTTP 合同无法原位收紧时，增加一个最薄的任务型路由复用该模块，并让超范围旧路由退出公共注册；不得长期同时维护宽、窄两套公共接口。
4. 请求 Schema 只接受原型需要的输入，响应 DTO 只返回原型需要的字段；原型没有的操作不注册公共路由。只在前端隐藏按钮或忽略多余字段不算完成。
5. 收紧公共合同不得删除项目隔离、Origin/CSRF、容量、输入验证、幂等、事务、来源、删除安全和审计等内部保护。

每张 Ticket 的 Comments 记录相关路由的处置：`reused`、`narrowed` 或 `retired`。Ticket 27 对正式运行时做最终路由清单检查。

### 5.1 Project Workspace

- `listProjects(context, query): ProjectPage`
- `createProject(context, name, description?): ProjectRef`
- `openProject(context, projectId): ProjectWorkspace`

创建项目与固定“未整理”在同一事务完成。查询始终携带项目/Owner 范围。没有 rename、delete、member 或 settings 命令。

### 5.2 Raw Material Collection

- `listCollections(context, query): CollectionPage`
- `createCollection(context, name, description?): CollectionRef`
- `listFiles(context, collectionId, query): MaterialFilePage`
- `queryRecords(context, collectionId, query): MaterialRecordPage`
- `moveAsset(context, assetId, targetCollectionId): void`

每个项目恰有一个“未整理”；文件只属于一个数据集；移动不改变文件或来源身份。正式公共接口不提供集合 rename/delete。

### 5.3 Confirmed Upload

- `start(context, descriptor, bytes): PendingUploadRef`
- `preview(context, pendingUploadId, displayMapping): MaterialPreview`
- `confirmBatch(context, pendingUploadIds, collectionId, idempotencyKey): AssetReceipt[]`
- `cancelBatch(context, pendingUploadIds): void`

服务端自动识别 CSV/JSON/JSONL 并返回原型需要的字段、样例、记录、可定位问题和映射预览。前端以拖拽字段卡把一个源字段分配到问题、期望输出或 Metadata；同一字段只能保留一个映射，问题/期望输出各只接受一个字段。高级 parser 配置不进入公共单人工作流。

单文件读到第 50,000,001 byte 时阻断。确认前不创建数据资产；批次确认失败不产生部分可见提交；重试返回相同结果。

### 5.4 Parsed View

- `queryFileRecords(context, assetId, query): SourceRecordPage`
- `queryCollectionRecords(context, collectionId, query): SourceRecordPage`
- `getRecordDetail(context, assetId, ordinal): SourceRecordDetail`
- `openRawPreview(context, assetId, maxBytes = 1_000_000): RawContentPreview`

三个格式共享同一 Source Record 结构。浏览映射输出问题、期望输出和有序 Metadata 项，保留源字段显示名和值；记录顺序和 locator 稳定，原字段和值不被映射改写。原始内容预览在服务端按 1,000,000 bytes 截断到有效文本边界并返回截断事实，浏览器不重缓冲完整文件。UI 只消费名称搜索和三字段记录搜索，不暴露任意查询语言。

### 5.5 Solo Test Set Editor

- `startNewTestSet(context, name, purpose?): EditSession`
- `startFromVersion(context, versionId): EditSession`
- `selectSources(context, editId, selections): EditState`
- `applyEdits(context, editId, expectedRevision, edits): EditState`
- `publish(context, editId, idempotencyKey): VersionRef`

Facade 内部可复用 Working Draft、lease、Candidate、Schema、case identity 和 publication，但公共请求/响应只出现冻结原型的名称、用途、来源选择、三字段记录、数据核对和创建动作。

Metadata 由服务端以有序键值项安全编码；同一记录内字段名不区分大小写重复时拒绝写入。旧单文本以唯一 `Metadata` 项读取和导出，不重写历史版本。界面不增加 JSON/Schema 步骤。问题未填写、完全重复和来源计数只生成提示，不成为发布阻断。

### 5.6 Version Graph

- `getVersionGraph(context, testSetId): VersionGraph`
- `getVersion(context, versionId): VersionDetail`
- `queryVersionRecords(context, versionId, query): VersionRecordPage`
- `getVersionRecordDetail(context, versionId, ordinal): VersionRecordDetail`

发布在锁定的测试集事务内分配 `publication_order`、`generation`、`branch_number` 和 `version_label`。同一或不同父版本并发发布不重复标签；失败不消耗标签。父边和标签发布后不可修改。

版本记录查询只允许搜索、分页以及来源文件、问题是否填写、记录来源、Metadata 字段和值包含的白名单条件；不同条件以 AND 合并，多选来源文件在该条件内匹配任一项。公共接口不提供 set-default、archive、compare-two、merge、rebase、rename、reparent、任意查询或保存筛选。来源页只计算当前版本相对直接父版本的变化。

所有版本读取通过同一个内部解析模块：`legacy_full_v1` 直接读取既有完整成员；`delta_v1` 从最近有效 Checkpoint 回放其后的记录级 Delta，再执行筛选、计数、分页、来源或下载。调用方不得自行解释存储格式，也不得先分页 Checkpoint 再叠加 Delta。

### 5.7 Provenance

- `getVersionProvenance(context, versionId, query): ProvenancePage`
- `getRecordChange(context, versionId, recordId): RecordChangeDetail`

返回父版本、本次新加入资料、未改变/修改/新增/移除计数、记录来源、前值和变化字段。稳定 case/revision、父修订和来源 edge 是内部事实；不提供处理运行登记、血缘粒度选择或多跳关系图。

### 5.8 CSV Download

- `openDataCsv(context, versionId): AuthorizedByteStream`
- `openProvenanceCsv(context, versionId): AuthorizedByteStream`

两个流都显式绑定 version ID，使用 UTF-8、稳定顺序和安全 CSV 转义；Metadata 按项顺序呈现为“字段：值”文本。浏览器“下载数据与溯源”依次请求两份 CSV。

Phase 1A 不公开 ZIP、Standard/Full Package、Offline Validator、Delivery Record 或 Langfuse CSV。既有确定性 JSON/JSONL/hash 代码可作为版本完整性内部实现保留，但不是公共产品。

### 5.9 Trash and Permanent Delete

- `trashTestSet(context, testSetId)`
- `trashVersionBranch(context, rootVersionId)`
- `restoreTrashEntry(context, entryId)`
- `permanentlyDeleteTrashEntry(context, entryId, confirmationNameOrVersionLabel)`
- `tombstoneMiddleVersion(context, versionId, confirmationVersionLabel)`

回收只改变可见性。整套测试集从列表回收时吸收其已回收版本分支；恢复整套测试集时，服务端在同一事务中恢复其可恢复版本并关闭被吸收的分支条目。中间版本只能整支回收，或删除自身内容并保留墓碑。永久删除和墓碑必须在锁定当前对象后精确验证输入的测试集名称或版本号，再计算真实依赖、保护共享内容、按 [ADR-0011](../adr/0011-incremental-test-set-version-storage.md#永久删除时切断存储依赖)为存活后代建立必要的依赖切断 Checkpoint、阻断并发读取并幂等清理；这些步骤不增加影响预览、理由、审批、外部副本或 Job 页面。

## 6. 数据与版本不变量

- 数据集是浅层归类；项目、数据集和测试集不可跨项目引用。
- 原始文件确认后不可覆盖；同字节复用存储不合并来源身份。
- 一个编辑会话最多一个父版本、5 个文件、100,000,000 原始 bytes 和 10,000 条源记录。
- 单文件最多 50,000,000 bytes 和 10,000 条源记录。
- 正式版本最多 10,000 条记录和 100,000,000 bytes 规范化内容；版本记录读取必须分页，不能为筛选在浏览器加载整版记录。
- 版本记录、父边、标签、来源和修改事实原子可见。
- 每个版本逻辑上始终是完整快照；物理 Delta、Checkpoint 和 legacy 完整成员解析后必须得到相同的内容、顺序、来源、修改事实和 hash。
- 后台 Checkpoint 在 20 代或累计 20% 变化时触发；任何可见版本不得超过 40 代或累计 40% 变化的回放硬上限。
- 回收/恢复不改写历史；永久删除不复用标签；墓碑后代不改挂。

## 7. 内部作业、幂等与错误

长操作可以使用 PostgreSQL 作业表和 Worker。状态、租约、重试、取消和 correlation ID 只用于内部协调和诊断。正式 UI 只显示：

- 当前动作正在处理；
- 成功结果；
- 可执行的错误和重试入口。

不得显示 Job ID、Lease、Candidate、Schema、Delivery Record 或内部堆栈。所有写命令携带项目、Owner、幂等键和期望修订；Worker 复检对象仍属于该项目。

## 8. 删除传播

1. 回收站动作只更新 visibility，可原位恢复。
2. 永久删除确认锁定目标与后代范围。
3. 服务端复检项目、共享引用和当前状态。
4. 先阻断新读取/引用，再为跨出删除范围的第一层存活版本建立并校验必要的依赖切断 Checkpoint。
5. 全部存活分支可独立解析后，才删除专属 MinIO/数据库内容。
6. 中间版本保留最小墓碑、原标签和父边。
7. 局部失败保持不可访问并可安全重试，不重新暴露已删除内容。

[ADR-0008](../adr/0008-controlled-deletion-propagation.md)只保留上述 fail-closed、共享引用和墓碑技术原则；其旧“受控删除”用户步骤已被冻结原型 v5.3 取代。

## 9. 请求边界

- Fastify 从受限非生产配置非交互式解析唯一 Owner。
- 所有查询/命令显式校验 `project_id + actor_id`。
- 不透明 ID 查询后再次复检项目，跨项目统一返回不泄漏存在性的拒绝。
- 写请求验证 Origin/CSRF 和请求大小。
- 下载再次校验项目与选中 version ID。
- 日志和指标不得包含原始正文、凭据或可下载 URL。

## 10. 测试 seam

| Seam             | 必要证据                                             |
| ---------------- | ---------------------------------------------------- |
| HTTP             | 当前 Ticket 正常路径和一个关键失败/边界              |
| PostgreSQL/MinIO | 迁移、事务、持久化、共享引用或删除语义改变时         |
| Browser          | 当前 Ticket 对应的冻结原型路径                       |
| CSV              | 指定版本、Unicode/换行/逗号/公式前缀                 |
| Deployment       | `frontend-v3` 唯一静态来源、健康 SHA、监听和正常重启 |

每张 Ticket 默认不运行全部历史测试；按 [Test Plan](../test-plan-phase1a.md)选择必要集合。

## 11. 非生产边界

允许范围、容量和网络边界遵守 PRD。Non-production Server Development Gate 已 Passed。Production Gate 仍为 Not Evaluated / Not Approved。任何生产、公网、敏感数据、第二真实用户或备份承诺均需另行评审，且不得作为 Phase 1A 页面。

## 12. ADR 状态

| ADR       | 当前作用                                                    |
| --------- | ----------------------------------------------------------- |
| 0001–0002 | 部署拓扑、PostgreSQL/MinIO 职责                             |
| 0003–0004 | 原子版本分配、内部作业与租约                                |
| 0005      | 仅保留确定性序列化/hash 原则；Package/CLI 不再是产品        |
| 0006      | 仅保留内部安全序列化/Schema 能力；不阻断原型提示项          |
| 0007      | 稳定测试记录身份与修订                                      |
| 0008      | 仅保留 fail-closed 删除、共享引用和墓碑原则；无独立用户流程 |
| 0009      | 确认前不可见的上传边界                                      |
| 0010      | 结构化 Metadata 项与旧单文本兼容                            |
| 0011      | 测试集稀疏 Delta、关系表 Checkpoint、阈值和删除依赖切断     |
