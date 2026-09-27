# EvalBase Phase 1A Implementation Spec

| Item                  | Decision                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| Status                | Ready for sequential non-production implementation                        |
| Product authority     | `docs/PRD-evalbase-v1.md` — EvalBase v1                                    |
| Domain authority      | `CONTEXT.md`                                                              |
| User-visible contract | `92cb8a5` / `prototype/solo-workflow-v5.3`                                |
| Formal frontend       | `frontend-v3/` copied from immutable `frontend-v1/`                       |
| Deprecated frontend   | `frontend-v2/`, history only                                              |
| Test rule             | Current public normal path, one critical boundary, affected static checks |

## Authority and scope

The frozen prototype is exhaustive for user-visible functionality. Implementation must expose every frozen action and no extra page, field, CLI, state choice, or workflow. The formal product uses “期望输出” in place of the prototype's “预测输出”.

PostgreSQL/MinIO persistence, byte limits, hashes, project isolation, Origin/CSRF, idempotency, atomic publication, stable record identity, provenance facts, safe CSV, fail-closed deletion and audit remain internal implementation constraints. They do not authorize additional user steps.

Phase 1A has one real Owner, no login, non-production use, allowed non-sensitive data only, and no Production Gate claim.

## Solution

The browser opens at the project list. The Owner creates or opens a project, then works through two project children:

`Datasets → confirmed upload → unified records → Test Set v1 → derived versions → provenance → CSV downloads → Trash/permanent deletion`

`frontend-v1/` remains unchanged. Ticket 20 copies it to `frontend-v3/`; all new formal frontend work happens there. `frontend-v2/` and `src/web/` remain historical until Ticket 27 removes them from build/runtime.

## Public behaviors

### Project Workspace

- List, search, paginate, create and open projects.
- New project input is name plus optional description.
- Creation atomically creates one fixed Unfiled collection.
- Entered project name appears in the sidebar; Datasets and Test Sets are children.
- Switch project or create another project from the switcher.
- No project rename, delete, settings, members or cross-project references.

### Raw Material Collection

- UI calls a Raw Material Collection “数据集”.
- List columns are name, type, file count, unified record count, status, updated time and View.
- List supports name/description search, type filter, content filter, updated sort and 10-row pagination.
- Create uses name plus optional description.
- Collections are shallow and cannot be renamed, deleted or nested.

### Confirmed upload

- Repeated native file selections append to one open upload queue; the same local selection is listed once.
- A project accepts only one active Data Asset for exact original-byte SHA-256 content. Duplicate items are skipped before mapping; another project may retain the same bytes.
- This asset-level guard does not merge, suppress or otherwise deduplicate Source Records or Test Records.
- Dataset home and file page have no right-side information panel.

### Confirmed Upload

- Step 1 selects one or more CSV/JSON/JSONL files and a target dataset.
- Step 2 processes each file in sequence and shows source-field cards with sample values plus Question, Expected Output and Metadata drag targets.
- One source field maps to at most one target. Question/Expected Output each accept at most one source field; Metadata accepts multiple and preserves each source field display name and value. Source cards show an assigned mark; target chips can be removed or dragged to reassign.
- Show real source/mapped counts, localized parse issues and mapped record preview.
- One final confirmation saves the batch; closing cancels unsaved files.
- No encoding, delimiter, header, quote, JSON path, type-coercion or bad-row exclusion editor.
- Server streams at most 50,000,000 bytes per file, hashes bytes, stages objects and creates no visible Data Asset before confirmation.
- Confirm is atomic and idempotent; failure/cancel/expiry leaves no visible partial asset.

### Material Browser

- Dataset detail switches between Files and All Records.
- Files show name, format, size, record count, upload time, status, Move and View.
- Only file-name search is present. Selecting a row only highlights it; View opens the file.
- Move targets another dataset in the same project and preserves asset identity, bytes, mapping, provenance and locator.
- All Records searches and paginates Question/Expected Output/Metadata across files with a Source File column; records have stable ordinals, details and session-only row density.
- File records search and paginate the same three fields, provide the same detail/density behavior, and open a read-only first-1,000,000-byte raw preview with an explicit truncation notice.

### Solo Test Set Editor

- New Test Set asks only for name and optional purpose.
- Select sources by dataset, file and individual real record.
- Edit a three-column table: Question, Expected Output and Metadata; add, modify or remove rows.
- Metadata is an ordered field/value list in the UI; duplicate field names are rejected without exposing JSON or Schema controls. Legacy single text reads as one `Metadata` field.
- Data Check reports missing questions, exact duplicates and traceable count as warnings only.
- User does not enter version notes, per-row reasons, Schema, mode, default selection, filters or sampling rules.
- Publish `v1` atomically; failed/retried publication creates no half-version or duplicate label.

### Test Set Version

- Start from any selected complete version; inherit all its rows.
- Additional datasets/files/records are optional.
- Publish creates a new immutable version without changing any existing version.
- `publication_order` is commit order; `generation` and `parent_version_id` position nodes.
- Labels use `vN` or `vN-bK`; branch numbers are test-set-global, unique and never reused.
- Version graph returns all nodes/edges, highlights the selected ancestor path and offers Fit only on overflow.
- Version records search and paginate server-side, open details by ordinal, preserve structured Metadata and offer session-only row density.
- Fixed filters are source file, question presence, source/manual origin, and Metadata field/value contains; conditions use AND, selected source files use OR within that condition, and applied filters can be removed or cleared.
- No set-default, archive, arbitrary two-version comparison, merge, rebase, rename or reparent.

### Provenance and Change Facts

- Version summary shows parent, created time, record count, inherited purpose, source and change summary.
- Provenance page shows direct parent, current version, unchanged/modified/added/removed counts and newly added files.
- Added-file mappings are collapsed by default.
- Default filter is Changed; alternatives are All, Unchanged, Modified, Added and Removed.
- Search, paginate and open a record change detail.
- Detail shows current content, previous/removed content, source file/record and changed fields.
- Stable case/revision and source edges are internal. No transformation-run registration, lineage granularity choice, Prompt/tool evidence or multi-hop graph.

### CSV Download

- `GET data CSV` and `GET provenance CSV` require an explicit version ID.
- “下载 CSV” downloads the data CSV.
- “下载数据与溯源” downloads data CSV and provenance CSV as two files.
- CSV is deterministic UTF-8 with stable row order, correct quoting and spreadsheet-formula protection.
- No ZIP, Standard/Full Package, Offline Validator, Delivery Record, Langfuse CSV or sync.

### Trash and Permanent Deletion

- Trash an entire Test Set only from its list-row trash icon; restore it from the Trash dialog.
- Trash/restore a leaf version or complete descendant branch.
- A middle version cannot be hidden alone and descendants are never reparented.
- Trash is separated into Test Sets and Versions / Version Branches. Trashing an entire Test Set absorbs its already-trashed branches; restoring it restores those branches without leaving an active branch entry.
- Permanent Test Set deletion requires its exact name; permanent Version / Version Branch deletion requires its root label; a middle-version tombstone requires its label. The server rechecks the exact current value while holding the relevant row lock.
- A middle version can instead delete content and retain a tombstone node.
- Tombstone retains label, parent edge, deletion time and minimal relationship facts; it cannot be browsed, downloaded or used as a parent.
- Server validates the real dependency closure, preserves shared content still referenced elsewhere, blocks reads before destructive cleanup and retries idempotently.
- No separate controlled-deletion page, structured reason, approver, external-copy checklist or deletion-job UI.

## Internal decisions

### PostgreSQL and MinIO

PostgreSQL owns identity, relations, state, version allocation, provenance, visibility, idempotency and audit. MinIO owns staged/original/version/CSV bytes. Database-visible objects reference committed MinIO objects only.

### Capacity

| Boundary                   | Maximum                                                   |
| -------------------------- | --------------------------------------------------------- |
| One source file            | 50,000,000 bytes and 10,000 source records                |
| One edit's attached source | 5 assets, 100,000,000 raw bytes and 10,000 source records |
| One published version      | 10,000 records and 100,000,000 normalized bytes           |

Exact boundary succeeds; the next byte/record fails without losing editable state.

### Public API fit

Public HTTP is part of the exhaustive prototype surface. For each Ticket, inventory the affected routes and callers, then:

- reuse an existing route only when its request, response and actions already match the prototype;
- otherwise narrow it in place when no other current approved behavior consumes the wider contract;
- when only the deep module is reusable, expose the thinnest task route and retire the wider public route;
- never preserve a wider route solely for `frontend-v2`, historical Tickets or old tests;
- keep trust-boundary validation, project isolation, capacity, idempotency, atomicity, provenance and deletion safety inside the reused module.

Each Ticket records `reused`, `narrowed` and `retired` routes. Ticket 27 verifies that the formal runtime registers no user-operable route for a behavior absent from the frozen prototype.

### Request boundary

- Non-interactive sole-Owner identity only; no login route or user selector.
- Every command/query verifies actor and project; opaque IDs are rechecked after lookup.
- Writes verify Origin/CSRF and request size.
- Downloads reauthorize the explicit project/version.
- Logs/errors/metrics exclude record bodies, credentials and object URLs.

### Publication

Internal Draft, lease, Candidate and Formal Schema may be reused only behind the task facade. Publication locks the Test Set row, rechecks capacity/identity/provenance, allocates the label, commits version facts and exposes bytes atomically. User-visible warning fields are not converted into hidden publication blockers.

### Background work

Parser, publication, CSV and deletion may use persisted jobs, leases, retries and cancellation. The UI shows only in-place waiting, success or actionable error. Job/Lease/Candidate/Schema/Delivery identifiers are not part of the public workflow.

### Durability

Normal process/container restart and redeployment preserve PostgreSQL and MinIO data. This is local persistence, not backup, disaster recovery, RPO, RTO or SLA.

## Incremental version storage implementation contract

本节是增量存储 Tickets 33–38 的共同实施合同。依据 [ADR-0011](../../docs/adr/0011-incremental-test-set-version-storage.md)、[Architecture](../../docs/architecture/phase1a-architecture.md) 与 [Test Plan §H](../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)。ADR 的字段、manifest、阈值和删除策略为权威；Spike 是实验依据，不可直接作为正式数据库迁移或生产性能承诺。

### Migration and unified reads

- 加法迁移引入 ADR-0011 的格式标识、Delta 和 Checkpoint 表；既有版本保持 legacy，既有 ID、hash、标签、父边和对象不重写。
- 迁移须显式验证 PostgreSQL CHECK 的 NULL 三值逻辑，要求非空的 hash 不得以 NULL 绕过；case/revision/test-set 一致性在发布与 Checkpoint 提交前复检。
- 统一版本模块提供按版本查询、详情和有序遍历；先完成祖先 Checkpoint 与 Delta 解析，再筛选、计数和分页。浏览、编辑、摘要、核对、来源、CSV、完整性扫描与删除引用分析均使用它，不能遗漏旧 `version_member` 直接查询调用方。
- Checkpoint 属于已有版本，不新增图节点。空版、净零变化、删后追加、重复修改同一 case、历史分支与旧 Metadata 均保持逻辑快照语义。位置分配不能在删除末尾记录后误复用该路径已使用的位置；实现须保存或可靠推导路径位置高水位，Checkpoint 后仍可用。
- Ticket 33 的内部位置合同：`version_member.ordinal` 读取时转为 `bigint`，作为旧版稳定位置；PostgreSQL `bigint` 在 Node 侧保留十进制字符串，内部运算转为 `bigint`，JSON/HTTP 若需传递位置则用十进制字符串，不能经 JS `number`。后续发布器按指定父版本路径（含已删除记录的 Delta、旧成员和 Checkpoint）求历史最高位置并加一；不得只取当前可见成员的 `MAX(position)`，也不得混入兄弟分支。页面序号由当前快照重新编号，与稳定位置分开。

### Sparse publication and artifacts

- 复用现有创建和派生入口；派生请求携带净 add/update/delete 操作，update/delete 绑定指定父版本的 case/revision。新增 case ID 和来源由服务端验证并分配；不接受客户端伪造的来源、位置或版本标签。
- 前后端折叠改回原值、新增后删除与重复操作；跨页未提交修改不能丢失。服务端独立校验最终整版容量、Metadata 与来源，提示性数据核对不变。
- 新修订只为内容或来源变化记录创建。普通派生不写 N 条成员或完整 records 对象；Manifest 必须包含新修订正文及来源，不能照抄 Spike 中仅有 revision 指针的小 manifest。
- 完整 payload/evidence hash、Delta hash、manifest hash 各司其职，旧格式校验不变。规范化、空值与 64 位 position 的 JSON 编码必须确定且无精度丢失；用版本化 golden fixture 锁定。
- 同一测试集发布沿用锁、标签分配和幂等；对象提交完成后数据库才使版本可见。对象成功/事务失败允许孤立对象，响应丢失后重试必须返回同一版本。candidate 等兼容引用不得偷偷保留整版副本或被孤立对象清理器误删。

### Checkpoint, deletion and download

- 按 ADR-0011 实现后台触发与同步硬上限，阈值是待正式边界测试的工程决策，不是 Spike 已测得的最优参数。Worker 停止不能产生超限可见链，失败不消耗标签或留下半版本。
- 发布、Checkpoint 和删除按 test-set 锁优先、版本 ID 稳定顺序复检，Checkpoint 半成品不可见；存活依赖尚存在时禁止回收必要 Checkpoint。
- 删除先阻断目标公开访问，再保护所有存活边界分支。已有周期 Checkpoint 若成为唯一基线，必须提升为 required_dependency；叶子也依赖其自身基线。清理涉及 PG 修订、Delta、manifest、candidate 引用、CSV 缓存和 staging，不能只删除其中一侧。
- 来源页继续提供存活版本依法保留的前值和修改事实；删除目标的专属正文不得经 before、parent_revision、manifest 或缓存泄漏。共享内容只按真实存活引用保留，图父边不充当永久正文引用。
- 两份 CSV 绑定选中 version ID；缓存键包含版本、导出类型、序列化版本及对应证据指纹。缓存命中仍验证可见性；来源移动等影响输出时失效，失败对象不登记命中。

### Rollout and frontend parity

- Tickets 33–37 保持日常公共写入 legacy；Delta 测试只能在隔离合成 fixture/内部测试入口运行，不新增可被 Owner 调用的试验路由。
- Ticket 38 前后端同批切换到稀疏协议和 delta_v1 写入，覆盖新建 v1 与任意旧/新父版本派生；前端仅做内部提交协议适配，UI 零变化。切换前以同一合成逻辑版本比较 legacy/delta 的内容、顺序、来源和两个 CSV。
- **所有受影响前端 UI 必须逐项对齐冻结 v5.3 原型。** 名称、控件顺序、图、摘要、Metadata、行高、分页、对话框与空/错状态均保持；沿用 frontend-v1 donor，不能增加格式选择、Checkpoint 设置或后台作业页面。
- 关闭 Delta 写入不等于可以退回旧二进制；已有 Delta 必须始终可读。旧程序降级须先完整物化兼容数据，未实施时只允许向前修复。
- 每张 Ticket 单独授权、分支开发并在共同功能分支集成；通过验收前不合并 main，不操作正式部署数据。Owner checkpoint 按 [Test Plan §H.3](../../docs/test-plan-phase1a.md#h3-切换与验收规则) 的四批执行；Ticket 35 仅交自动化证据并等待单独授权 Ticket 36。每批提供固定 HEAD 的前后端环境、已预置的少量合成测试内容、URL/SSH 命令和最小人工步骤；验收通过后按根 AGENTS.md 回收该批专用资源。

## Public test seams

| Seam             | Evidence                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| HTTP             | Exact request/response contract, current normal behavior and one critical boundary |
| Browser          | Exact frozen-prototype path added by the Ticket                                    |
| PostgreSQL/MinIO | Migration, transaction, persistence, shared-reference or deletion changes          |
| CSV              | Explicit version binding and hostile/unicode cell fixture                          |
| Deployment       | Only `frontend-v3` built/served, health SHA and normal restart                     |

Tests assert public results, stable errors, state transitions and immutable artifacts, not private tables, keys or helper calls.

## Ticket order

| Ticket | Vertical result                                                  |
| ------ | ---------------------------------------------------------------- |
| 20     | Copy donor to `frontend-v3`; project workspace and dataset index |
| 21     | Two-step confirmed multi-file upload                             |
| 22     | Dataset file/all-record browser and move                         |
| 23     | Select/edit records and create Test Set `v1`                     |
| 24     | Derive versions and browse version graph                         |
| 25     | Provenance, change details and two CSV downloads                 |
| 26     | Trash, restore, permanent deletion and tombstones                |
| 27     | Cut over build/deployment and complete Owner loop                |
| 28     | Upload queue append and project content deduplication            |
| 29     | Structured Metadata and raw-record browser correction            |
| 30     | Structured Test Set records, filters and version browsing        |
| 31     | v5.3 drag-mapped upload parity                                   |
| 32     | v5.3 Trash, typed deletion and restore parity                    |
| [33](./issues/33-incremental-schema-and-legacy-compatibility.md) | 加法迁移与旧版本兼容 |
| [34](./issues/34-unified-version-resolution.md) | 统一版本读取、筛选、来源与 CSV |
| [35](./issues/35-sparse-publication-and-manifest.md) | 稀疏发布和正式 manifest；公共写入仍 legacy |
| [36](./issues/36-checkpoint-scheduling-and-limits.md) | Checkpoint 后台触发、硬上限和失败保护 |
| [37](./issues/37-deletion-dependency-cut-and-export-cache.md) | 删除依赖切断与下载缓存安全 |
| [38](./issues/38-incremental-editor-and-format-cutover.md) | 派生版本增量提交协议切换与最终验收（UI 零变化） |

Each Ticket requires separate Owner authorization and stops after a local commit/report. Tickets 01–19 are historical records: completed entries retain implementation evidence, while any unstarted entry is superseded by the v5.3 sequence. None defines the new user surface.

## Out of scope

- Any user-visible capability absent from the frozen prototype.
- Login/authentication UI, users, roles, sharing and collaboration.
- Project/dataset rename or delete, nested folders and cross-project moves.
- Advanced parser configuration, arbitrary mapping, Schema UI, arbitrary/saved filters or sampling recipes, join/dedup.
- Default switching, archive, arbitrary comparison, merge/rebase.
- Transformation runs, processing manifests, lineage graphs or evidence editors.
- Package/ZIP/CLI/validator/Delivery/Langfuse features.
- Controlled-deletion governance UI.
- Evaluation execution/results and all Phase 1B capabilities.
- Production, public internet, sensitive data, backup and SLA.

## Completion

Phase 1A completes only when fixed-HEAD `frontend-v3` implements every frozen v5.3 path, exposes no additional Owner operation, passes the necessary affected tests, survives normal restart and receives explicit Owner browser acceptance. Production Gate remains Not Evaluated / Not Approved.
