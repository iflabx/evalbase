# V2-03：完整草稿工作区与可靠发布

Status: ready-for-agent
Implementation: completed

Blocked by: 批次 A 经 Owner 验收通过；获得本 Ticket/批次 B 执行授权。
Checkpoint: B（本 Ticket 完成后一次人工验收）

## Outcome

用户在全页完成创建/派生、资料选择、保存退出和继续、删除及发布；草稿按父版本隔离，发布唯一，回收恢复有完整规则。

## Required reading

- [Implementation Spec](../spec.md)，含统一执行协议、依赖、测试归属及 checkpoint 资源回收。
- Spec §1 链接的 PRD、CONTEXT、架构、测试计划、冻结原型与 donor 复用合同。
- [ADR 0013](../../../docs/adr/0013-v2-shared-draft-publication.md)、[ADR 0003](../../../docs/adr/0003-atomic-publication-and-version-allocation.md)、[ADR 0004](../../../docs/adr/0004-postgres-coordination-for-jobs-and-draft-leases.md)、[ADR 0007](../../../docs/adr/0007-test-case-identity-and-revisions.md)、[ADR 0008](../../../docs/adr/0008-controlled-deletion-propagation.md)、[ADR 0010](../../../docs/adr/0010-structured-metadata-entries.md)、[ADR 0011](../../../docs/adr/0011-incremental-test-set-version-storage.md)。

## Scope

- 创建稳定持久化草稿身份：同父一个活动草稿、异父隔离、多个独立新建测试集草稿；列表和版本处发现、继续、显示最近修改者与时间。
- 全页编辑与资料选择，搜索分页、固定全选范围及跨页排除；整行打开右侧记录编辑，Metadata 直接键值编辑并允许空值。
- 完成真实保存反馈、保存退出、恢复、删除；服务端字段/行 revision 检查防止丢更新，基本冲突界面保留输入；从第一次保存起记录可信修改者 ID/时间。
- 发布固定修订，数据库保证整个 draft 只对应一个正式版本；不同用户/幂等键/响应丢失和重启恢复复用结果。复用既有 Sparse 发布器及 Delta/Checkpoint 读取。
- 回收父对象暂停草稿，恢复后继续；永久删除终止相关草稿并清理正文、暂存及缓存，保护其他存活依赖；处理删除/发布/保存竞态。

## Acceptance Criteria

1. 两个父版本的草稿互不影响，同父两账号进入同一草稿；两个新建草稿独立列出且均可继续。查看者不能访问草稿列表、正文和编辑位置。
2. 跨页选择准确；重复同一来源不重复加入；保存失败不退出不丢输入，刷新/重启恢复服务端内容。
3. Metadata 空值可编辑、发布、下载；空键/重复键拒绝；问题为空及内容重复仍只提示，容量沿用 v1。
4. 不同字段并发保存均成功，同字段和删行竞争明确冲突，不静默覆盖；发布中禁止编辑/删除，失败恢复后旧任务不能提交旧快照。
5. 两个真实账号不同请求键发布同草稿只产生一个版本且返回相同 ID；故障注入重启无半成品、不消耗失败标签。
6. 草稿回收暂停/恢复/永久终止及迟到请求行为正确，legacy/Delta/Checkpoint 与 CSV 不回归；字段归属事实随发布保留，为 V2-04 展示提供真实数据。

## Necessary tests

DRAFT-01–04、EDIT-01–05、PUB-01–06、DELETE-01–03、COLLAB-01–04 的 HTTP 并发边界及 REG-01–02 受影响集合；重启持久化。首个 red 建议：同父并发创建只返回一个草稿，异父保存互不覆盖。高风险发布/删除按协议完成 Closure Review。

按实际 diff 选择受影响 typecheck、lint、frontend build 和文档检查。执行前记录具体命令与公共测试边界；完成后记录真实结果、未测项及原因。Standards/Spec 复审清除 P0/P1 后提交，不用单纯按钮禁用或 Mock 代替服务端证据。

## Frontend parity

**前端 UI 严格对齐冻结原型，样式严格沿用 frontend-v1。** 执行 [PRD §7](../../../docs/PRD-evalbase-v2.md#7-视觉与实现边界)，仅允许已确认产品差异及本 Ticket 明确分期项；checkpoint 前提供实际页面对照证据，修正未经确认的偏离。

新建/继续草稿入口、草稿记录/添加资料、行点击右侧编辑、Metadata 行内编辑、保存状态、删除确认、发布失败恢复。B 尚无自动实时推送/在线头像，明确标注阶段范围，不显示假头像；V2-04 补齐即时更新及字段作者完整展示。

实施前在本节补充 Ticket-local 对照表，逐项记录字段、顺序、标签、启用条件、空/错态和排除项；正式前端仅 frontend-v3，frontend-v1 只读。

### Ticket-local UI parity and public routes

| 位置 | 原型字段与顺序 | 状态及 B 期实现 |
| --- | --- | --- |
| 测试集列表/版本 | 新建测试集、继续编辑草稿、最近修改者/时间 | 查看者不可见；同父一个活动草稿；新建草稿可多个 |
| 来源与修改摘要 | 标题说明；基于版本、当前版本、本次结果；本次新加入的资料按文件显示新增数与可展开字段映射，手工新增单列 | 父版本按钮返回该版本；首版与无新增资料有明确文案；字段映射默认收起；读取失败提供重试；期望输出遵循 PRD，V2-04 作者展示不在本轮 |
| 草稿页头 | 返回、名称、用途、父版本、保存状态、保存并退出、删除当前草稿、创建版本 | 未保存和失败时留在本页，发布需名称及至少一条记录 |
| 草稿记录 | 草稿记录/添加资料；计数、新增记录、搜索；序号、问题/最近修改、预测输出、来源；20 条分页 | 整行打开右侧；空记录和无搜索结果分别提示 |
| 编辑记录 | 来源/序号、问题、预测输出、Metadata 键值行、添加字段、移除记录 | 空值合法；空键/重复键提示并保留输入；同字段冲突保留输入 |
| 添加资料 | 1.选择资料文件，2.选择记录；搜索、本页/全部结果/取消；文件 10 条/页，记录 20 条/页 | 固定搜索结果范围后批选，可跨页排除；服务端分页；来源去重 |
| 删除和发布 | 删除确认、发布结果/失败恢复 | 删除草稿不可恢复；固定已保存 revision，服务端唯一发布 |

### 公共路由清单

| 分类 | 路由 | 本 Ticket 用途 |
| --- | --- | --- |
| 新增 | `GET/POST /api/projects/:projectId/collaborative-drafts`；`GET/PATCH/DELETE /api/projects/:projectId/collaborative-drafts/:draftId` | 草稿列表、创建、分页正文、字段保存与删除 |
| 新增 | `POST /api/projects/:projectId/collaborative-drafts/:draftId/records`；`PATCH/DELETE /api/projects/:projectId/collaborative-drafts/:draftId/records/:recordId` | 记录增加、字段修订与移除 |
| 新增 | `POST /api/projects/:projectId/collaborative-drafts/:draftId/publish` | 固定修订发布及同草稿成功重放 |
| 新增 | `GET /api/projects/:projectId/collaborative-draft-source-files`；`GET /api/projects/:projectId/collaborative-draft-source-records`；`GET /api/projects/:projectId/collaborative-drafts/:draftId/selected-sources`；`POST /api/projects/:projectId/collaborative-drafts/:draftId/source-selection` | 资料搜索、分页、查看已选及批量增减 |
| 新增 | `/projects/$projectId/test-sets/drafts/$draftId` | 全页草稿工作区 |
| narrowed | `/projects/$projectId/test-sets`；`/projects/$projectId/test-sets/$testSetId` | 保留正式列表/版本详情，增加可继续草稿的入口 |
| reused | `GET /api/projects/:projectId/solo-test-sets` 及现有版本详情、读取、CSV；Sparse 发布器、Delta/Checkpoint；回收与恢复 API | 读取正式版本、可靠发布与依赖联动，未改正式版本公开格式 |
| narrowed（UI） | 测试集列表中旧新建弹窗入口 | 已改为全页草稿；旧 `/api/projects/:projectId/drafts` 暂仍注册但无当前 frontend-v3 调用方，列为 Closure Review 的 P2 清理项 |

前端严格取 `docs/prototypes/THROWAWAY-phase1a-login-multiuser-vnext.html` 的布局和 `frontend-v1` 的样式；B 不显示模拟在线头像、实时焦点或完整字段作者 UI（V2-04）。复用 `solo-test-sets` 的正式版本列表、详情、读取、CSV 和 Sparse 发布器；新增 `collaborative-drafts` 草稿接口；旧租约 `test-sets/drafts` 不再作为 V2 入口。首个 red：同父并发创建只返回一个草稿，异父保存互不覆盖。验证边界：HTTP 集成、受影响 typecheck/lint/build、完整测试、docs:check。

## Owner checkpoint

按 Spec 的 B 准备多页资料、空 Metadata、legacy 与增量父版本、两个独立新建草稿。人工走保存→继续→编辑→发布→回收恢复；同草稿唯一发布/故障恢复另交自动化证据。使用合成数据验证永久删除，按执行时规则取得必要确认。通过后释放 B 资源。

## Out of scope

不改正式叶子版本、不改 CSV 格式、不重写存储协议；本 Ticket 不实现 SSE/在线心跳和完整字段头像展示。

## Comments

- 2026-09-28：仅创建实施 Ticket，尚未执行测试或开发。完成后在此记录实现 SHA、验证、复审和批次验收证据，并同步 Spec 进度表。

- 2026-09-28：实现于 `6810790`，P1 修复于 `3d0d3bb`；本 Ticket 的固定代码 SHA 为 `3d0d3bbd0aa1f8f6a6ffe01ae258cfa728c6ab0`。采用 ADR 0013 的同父共享草稿与唯一发布、ADR 0003/0004 的原子分配与任务协调、ADR 0007/0008/0010/0011 的修订、删除、Metadata、增量版本边界；未扩张 PRD。
- Ticket Closure Review（固定代码 SHA）：**P0/P1 已清零**。身份/隔离：同父共享、异父隔离、多个新建草稿、查看者拒绝；来源：55 条文件跨 3 页、跨页排除与去重；保存：空 Metadata、字段与删行 409、保留本地输入、退出与恢复；发布：双账号不同请求键只生成同一版本，注入失败后重启不留半成品且不占失败标签；生命周期：回收暂停正文、恢复继续、永久删除终止编辑且保留已发布后代；兼容：legacy/Delta/Checkpoint 与 CSV 受影响回归。以上均由目标 HTTP 集成测试覆盖，前端保存、退出、整行编辑、来源分页和排除另经隔离浏览器核对。
- 自动化：`npm run typecheck`、`npm --prefix frontend-v3 run typecheck`、受影响 `eslint`、`npm --prefix frontend-v3 run build:formal`、`npm run docs:check`、`git diff --check` 均通过。B 隔离 Compose 中，`vitest run tests/integration/v2-collaborative-draft.test.ts tests/integration/v2-accounts.test.ts tests/integration/ticket38-cutover.test.ts` 为 **17/17**；最后的回收触发器修复后再跑 V2-03 文件为 **8/8**。此前单元测试为 **134/134**。完整旧集成测试因旧 Owner 夹具与 A 后权限规则冲突产生 403，未把它计为通过；未跑全量性能/安全与双浏览器实时 UI（实时展示属于 V2-04）。
- Standards/Spec 两轴复审确认修复了所有 P1。保留 P2：旧 `/api/projects/:projectId/drafts` 路由仍注册，当前 frontend-v3 已无调用；清理不阻断 B，后续可在不改变产品行为时移除。
- 批次 B 的 `evalbase-v2-b-owner-checkpoint` 隔离环境位于 `127.0.0.1:4217`，包含两个独立新建草稿、两个不同父版本的派生草稿、两份各 55 条来源文件；浏览器已核对 55→54 条跨页排除、保存与继续。**等待 Owner 验收**；验收前保留容器、网络、持久卷、合成数据和 4217 隧道。V2-04 须在 B 通过且另获开发授权后启动；本次没有合并 main、推送 GitHub 或正式部署。
