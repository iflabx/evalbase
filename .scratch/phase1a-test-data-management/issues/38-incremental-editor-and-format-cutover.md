# EvalBase-38：派生版本增量提交协议切换

Status: ready-for-agent
Implementation: completed

Blocked by: [Ticket 37](./37-deletion-dependency-cut-and-export-cache.md) 完成并通过 Owner checkpoint。 每张须 Owner 单独授权；创建文档不等于启动执行。

## Outcome

保持冻结原型 UI 和既有用户操作不变，仅将现有编辑页的提交协议切换为净变化，并在完整兼容与删除保护就绪后启用 delta_v1。

## Required reading

- [Implementation Spec — Incremental version storage implementation contract](../spec.md#incremental-version-storage-implementation-contract)
- [ADR-0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)
- [PRD](../../../docs/PRD-evalbase-v1.md)、[CONTEXT](../../../CONTEXT.md)、[Architecture](../../../docs/architecture/phase1a-architecture.md)
- [Test Plan §H](../../../docs/test-plan-phase1a.md#h-增量版本存储-tickets-3338)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)、[冻结原型](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- ADR-0002/0003/0005/0007/0008/0010，及根 AGENTS.md 的 Ticket 执行和 checkpoint 规则。

## Acceptance Criteria

1. 编辑按页加载父记录，以 case ID 保存增删改；换页/重载当前页不丢修改，改回原值和新增后删除折叠，附加来源可选，选择记录顺序不变。
2. 复用现有发布入口同时切换前后端协议，服务端独立校验；退出旧全量派生公共协议，不长期保留两套路由。新建 v1 为 initial checkpoint，任意 legacy/delta 父版可派生。
3. 不新增或重做任何 UI。现有编辑页仍须严格保持 v5.3 原型及 frontend-v1 donor 的控件顺序、版本图、摘要、来源、Metadata、行高、分页、弹窗和错误态；开始前写 Ticket-local parity 表，明确 UI 零变化。
4. 确认 33–37 完成且对应证据可追溯；切换默认新写入，旧版内容/hash 不改；禁用新写入仍保留 Delta 读取，记录不可直接降级旧二进制的限制。
5. 固定 HEAD 完成浏览器串联与重启持久化，在隔离 checkpoint 给 Owner 验收。此 Ticket 不自动合并 main、推送 GitHub 或部署正式环境。
6. 本 Ticket 的前端范围仅限内部提交协议适配（分页记录身份、净 add/update/delete 请求和失败重试状态保持）；不得增加格式选择、Checkpoint、Job、治理或其他原型外入口。若实现不需要可见改动，必须保留既有页面并在 parity 表中记录字段、控件顺序、标签、启用状态、空/错状态均未变化。

## Necessary tests

正常：两个来源创建 v1→跨页只改一条派生→从旧父创建分支→筛选/来源→两个 CSV→回收恢复/墓碑；核对提交请求只含净变化而无整版数组，同时核对页面视觉与交互无变化。边界：跨页编辑后发布失败保留编辑、幂等重试、旧文本 Metadata；复用 33–37 必要集成集合一次集中验收，并验证重启持久化、受影响前端 build/typecheck/lint。

执行受影响 typecheck、定向 lint、文档检查和 git diff --check；不默认全仓测试。最终 Standards/Spec 审查无未解决 P0/P1，Comments 记录真实命令、固定 SHA、未测项和 reused/narrowed/retired 路由盘点。

## Owner checkpoint

预置少量合成记录的旧格式父版本和两页可编辑内容，交付测试集链接/编号；新写入 v1 由 Owner 在隔离环境通过既有 UI 创建。Owner 在第一页改一条、下一页删一条并新增，返回确认修改保留；创建线性与旧父分支，查看摘要/来源、分别下载，完成回收恢复和合成中间节点墓碑。重启后再次打开同一版本核对记录仍在；全部界面与原型一致。净操作请求、旧版本兼容及重启数据由 Agent 的自动化/部署证据补充。

完成本地提交后，将独立 checkpoint 前后端切到当前固定 HEAD；验证 health/ready、预置内容的一次同源 API，并给出 URL、需要时的 SSH 隧道命令及上述手工步骤。Owner 通过并记录证据后回收本批专用资源；不自动合并 main、推送或部署。

## 前端 parity 表（实施前）

| 受影响项目 | 冻结 v5.3 原型 | Ticket 38 处理 |
| --- | --- | --- |
| 页面及可见字段 | 既有新建测试集与“基于版本创建版本”三步弹窗；编辑行显示序号、问题、预测输出、Metadata、删除 | 保留现有页面与字段；仅内部按页读取父记录并保存净变化 |
| 控件顺序与标签 | 添加资料 → 选择新增记录 → 编辑并创建；新增记录、取消、上一步、创建版本 | 保留现有控件顺序、标签和操作；不显示格式选择或 Checkpoint |
| 版本图、摘要、来源与下载 | 创建后仍通过既有版本页查看父子图、摘要、来源与修改、两个 CSV | 保留既有展示和下载入口，按逻辑完整快照读取 |
| 启用、空态与错误态 | 继承记录加载时等待；空记录不能发布；发布失败可重试，编辑内容仍在 | 保留现有状态和提示；失败重试沿用同一个幂等键 |
| 排列与行高 | 编辑行保持父版本顺序；已发布记录页分页与行高不变 | 内部分页加载不改变可见记录顺序或已发布页控件 |
| 明确排除 | 原型没有存储格式、Checkpoint、Job、治理入口 | 不新增这些控件或流程 |

## Out of scope

位图、版本标签数组、DVC/Dolt/lakeFS、新服务、新产品功能、旧历史批量压缩、正式环境迁移和未经请求的 GitHub 推送。具体实施遵照 Spec 的格式启用门槛。

## Comments

- 2026-09-18：按 Owner 授权同步 ADR/Spec/Test Plan 后创建；尚未实施、未运行测试、未建立本 Ticket checkpoint。

- 2026-09-27：Owner 已授权 Ticket 38。实现分支 `codex/ticket-38-incremental-editor-cutover`，运行时代码固定于 `b4168a4061d57ac22c5805614ff61e8752d5c9e4`（前置实现提交 `c679cd4`、`8b52c22`、`ed2fb19`、`8e85a1d`）。现有新建入口改为 delta_v1 initial Checkpoint；派生入口只接受净 add/update/delete，服务端自行校验；编辑页按 10 条分页继承、以 case ID 保存跨页编辑和删除、失败后保留相同幂等键。修复继承来源跨页保留、异步来源身份解析的顺序和过期结果；可见 UI 未增加控件。
- 路由盘点：复用根版本 `POST /api/projects/:projectId/solo-test-sets`、派生 `POST /api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/derived-versions`、编辑记录 `GET /api/projects/:projectId/solo-test-sets/:testSetId/versions/:versionId/editing-records`；缩窄派生 POST 的 body 为净操作，GET 增加 caseId/revisionId；退出全量派生 `records` 公共请求和前端一次性继承全版数据。没有新增路由。
- 验证：根与前端 typecheck、根 build、定向 ESLint、`git diff --check` 通过；Ticket 38 集成 3/3、solo v1 4/4、solo trash 19/19、迁移 6/6 通过。相邻批次 7 个相关测试文件通过；同一批次的 3 个历史 Ticket 14 测试文件因旧测试环境未播种会话而在 `/api/session` 返回 404，未将该批次记为全绿。Standards/Spec 复审无未解决 P0/P1；最后的前端来源 epoch 竞态修复在 `b4168a4`。
- 同环境热路径抽样：legacy/delta 各 21 条逻辑记录，三轮交错测试二页读取、筛选、数据 CSV、溯源 CSV、单条更新发布；数据在 `/tmp/evalbase-ticket38-benchmark.json`，web 容器 18 次抽样约 198.7–211.0 MiB。仅小样本暖缓存对比，不能推断生产规模；完整内容哈希与 Checkpoint 指针仍有 O(N) 成本。
- 隔离 checkpoint 使用 `evalbase-ticket38-owner-checkpoint`、端口 4218、固定代码 SHA `b4168a4`，合成旧格式父版本 21 条与两份来源资料。浏览器已验证 UI 新建 delta v1、派生 v2/v3、旧父跨页编辑与分支、来源/摘要/筛选/两种 CSV、web/worker 重启持久化，以及对象存储暂断导致的失败重试。随后浏览器完成回收恢复与合成中间节点墓碑，验收结论见下。未合并 main、推送或部署正式环境；禁用新 Delta 写入仍可读取已发布 Delta，旧二进制不可直接回退。

- 2026-09-27：Project Owner 授权 Agent 在完整浏览器测试通过时将本 checkpoint 记为通过，并在永久删除按钮前即时确认仅删除隔离合成 v2 内容。固定运行代码 SHA `b4168a4` 的浏览器测试已通过：新写入 v1→v2→v3、旧格式父版跨页净变化和分支、来源/筛选/两种 CSV、失败后同弹窗重试、回收站恢复；墓碑后 v2 直接访问返回 `version_not_found`，v3 仍有 3 条记录且两个 CSV 可下载。数据库显示 v2 tombstoned、item_count=0、变更/解析/导出缓存为 0，v3 保留父关系并有 3 成员 `deletion_cut` Checkpoint。重启隔离 web/worker 后 health SHA 未变，浏览器刷新仍显示墓碑和 v3 内容。Agent 判定 checkpoint 通过。
- 通过后保存浏览器摘要、DB 查询、测试与性能日志、服务日志、Compose 状态、health 和清理审计至 `local-acceptance-evidence/ticket38-owner-checkpoint-20260927/`，并验证 SHA-256 清单。仅删除 `evalbase-ticket38-test` 与 `evalbase-ticket38-owner-checkpoint` 专用容器、网络、卷、镜像；端口 4218 和本地 SSH 隧道已释放。正式 `evalbase` Compose 及其他项目未改动。分支保留，未合并 main、未推送、未正式部署；Production Gate 仍为 `Not Evaluated / Not Approved`。

- 2026-09-27：合并前复审修复提交 `4fd375b`、`328bc40`：编辑记录路由按来源身份精确过滤，前端选择来源和发布不再扫描未加载的父版本页面；一致性扫描按 legacy/Delta 格式检查 Candidate 与 Version，并将 Delta Candidate 与其 Version manifest 对齐。10,000 条父版本末尾来源查询、根/派生 Delta 扫描、损坏对象、计数漂移和参数边界有集成回归；相邻版本读取/发布/Checkpoint 集成 30/30，根单测 134/134，前端单测 1/1、构建、两端 typecheck、定向 lint、文档检查和 `main...HEAD` whitespace 检查通过。Standards/Spec 定向复审没有未解决 P0/P1；固定 manifest 读取上限 120 MB 的极限边界尚未单独验证，列为 P2。此修复后的固定 HEAD 尚未重新执行 Owner 浏览器 checkpoint；原通过记录仅对应 `b4168a4`。未合并 main、推送或正式部署，Production Gate 仍为 `Not Evaluated / Not Approved`。
