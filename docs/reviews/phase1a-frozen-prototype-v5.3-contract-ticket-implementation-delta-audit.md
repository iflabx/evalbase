# Phase 1A 冻结原型 v5.3 与合同、Ticket、实现差异审计

| 项目 | 内容 |
| --- | --- |
| 审计日期 | 2026-09-09 |
| 审计性质 | 只读比较后形成的合同同步记录；未把浏览器 Mock 当作服务端证据 |
| 冻结基线 | `92cb8a5` / `prototype/solo-workflow-v5.3` |
| 范围 | v5.2 已同步合同与 Tickets 20–30、今日原型提交、`frontend-v3/` 和现行 HTTP 实现 |
| 结论 | 合同已同步；Tickets 31、32 是实现 v5.3 差异的唯一后续入口 |

## 纳入的今日原型与文档

| 固定提交 / 文档 | 已验收事实 | 审计处置 |
| --- | --- | --- |
| `b52ef6a` | 上传字段映射从下拉选择改为源字段卡拖至问题、预测输出或 Metadata；卡片保留样例与已映射标记。 | 复用既有映射/预览 API，只改正式前端交互。正式产品仍显示“期望输出”。 |
| `92cb8a5` | 测试集列表增加整套回收入口；版本页只删除版本；回收站分组；永久删除和墓碑改为精确输入对象名称或版本号。 | 前端、公共确认请求和完整测试集恢复语义均需纠正。 |
| [v5.3 修订](../prototypes/phase1a-solo-workflow-v5.3-mapping-and-deletion-amendment.md) | 固定上述边界，不加入归档、审批、理由、保留期、Schema 或高级 parser。 | 作为现行冻结证据。 |
| [采用记录](../prototypes/solo-workflow-reference-adaptations.md) | 以 `frontend-v1/` 为视觉/component donor；`frontend-v3/` 是唯一正式前端。 | 每张后续 Web Ticket 逐项对齐原型，不以通用组件重解释页面。 |

## 差异矩阵

| ID | v5.3 事实 | 审计时的合同 / 实现 | 处置 |
| --- | --- | --- | --- |
| D53-01 | `92cb8a5` 是完整用户合同。 | 权威入口仍指向 v5.2。 | 已同步 PRD、CONTEXT、Architecture、Frontend reuse、Spec、Test Plan、系统流程、Owner 决策记录、AGENTS、README 与进度台账；v5.2 记录保持历史。 |
| D53-02 | 上传页使用拖拽源字段卡和目标区；一个源字段只保留一个映射。 | `frontend-v3` 的确认上传对话框仍以逐行 Select 映射；现有 API 已支持一问题、一预期输出和多 Metadata 的 preview。 | Ticket 31 只替换前端交互，复用现有待确认上传、preview、confirm seam。 |
| D53-03 | 整套测试集只能从列表垃圾桶回收，版本详情只处理版本。 | 列表缺少垃圾桶，版本详情仍有整套测试集“移入回收站”。 | Ticket 32 调整入口与可见动作，不增加删除页面或路由。 |
| D53-04 | 回收站分为测试集和版本/版本分支；永久删除/墓碑均输入精确名称或版本号。 | UI 是扁平列表和点击确认；服务端仅接受固定文字 `permanent_delete` 或 `delete_content_keep_relationship`。 | Ticket 32 将现有确认请求原位收紧为精确值，服务端锁定当前行后校验。 |
| D53-05 | 整套测试集回收吸收其已回收分支；恢复整套测试集后不留下孤立分支。 | 当前恢复路径只将 `test_set.status` 设回 available，先前 `trashed` 版本与分支条目仍保留。 | Ticket 32 在同一事务恢复版本、关闭被吸收条目，并证明分支先回收再整套回收/恢复的路径。 |

## 纠偏 Ticket

1. [Ticket 31](../../.scratch/phase1a-test-data-management/issues/31-v53-upload-drag-mapping-parity.md)：上传字段拖拽映射与预览 UI 对齐。它不改变上传数据模型、解析器、待确认上传或确认事务。
2. [Ticket 32](../../.scratch/phase1a-test-data-management/issues/32-v53-test-set-trash-and-typed-deletion-parity.md)：测试集回收入口、回收站分组、精确输入确认及整套恢复语义。它不增加新服务、回收状态、治理页或数据集原始文件删除。

每张 Ticket 都须在开始前写 Ticket-local v5.3 UI 对照表，并在 Owner checkpoint 对照冻结 HTML。未经 Project Owner 对该 Ticket 的单独授权，不得开始实现。

## 非目标

本审计不重开已验收 Tickets 20–30，不把 `frontend-v1/` 改为业务合同，也不添加登录、成员、归档、版本合并、保留策略、外部共享、生产能力或任何原型外动作。Production Gate 保持 `Not Evaluated / Not Approved`。
