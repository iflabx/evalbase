# Phase 1A 单人工作流：现有后端与冻结原型差距清单（历史）

> 本记录固定 Tickets 20–27 启动时的 v5 差距与复用判断。当前后续实施以 [v5.2 合同 / Ticket / 实现差异审计](phase1a-frozen-prototype-v5.2-contract-ticket-implementation-delta-audit.md)及现行 PRD 为准；不要以本记录扩展或重开已验收 Ticket。

| 项目         | 结论                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 更新日期     | 2026-09-03                                                                                                                |
| 用户合同基线 | commit `92b0113` / tag `prototype/solo-workflow-v5`                                                                       |
| 产品范围     | 受限非生产、Project Owner / Sole Developer、允许的非敏感数据                                                              |
| 总体结论     | 保留并适配现有 PostgreSQL + MinIO 后端；废弃 `frontend-v2/`，从 `frontend-v1/` 复制 `frontend-v3/` 后按原型重建正式前端。 |

本文是 Tickets 20–27 的差距与复用索引，不替代 PRD、`CONTEXT.md`、Architecture、ADR、Spec 或 Ticket，也不授权开始任何 Ticket。

## 1. 约束

- 冻结原型中的每个用户可见行为都必须存在；原型没有的用户操作、表单、页面、筛选、下载和治理步骤不得出现。
- `frontend-v1/` 是不可修改的视觉与组件 donor；`frontend-v2/` 只保留为历史证据；Ticket 20 从 donor 完整复制 `frontend-v3/`，之后只开发 `frontend-v3/`。
- 既有后端的持久化、项目隔离、Origin / CSRF、容量、幂等、原子性、稳定身份、来源事实、删除安全与必要审计可以作为不可见机制保留，但不得扩大用户表面。
- 不重写已经正确工作的深模块。新接口只编排原型需要的任务，不把内部 Working Draft、Schema、Candidate、Job、Delivery 或删除作业暴露给 Owner。

公共 HTTP 路由按 [Architecture §5.0](../architecture/phase1a-architecture.md#50-公共-api-适配规则)逐 Ticket 处置：完全匹配则直接复用，超出原型且无现行调用方则原位收紧，只有深模块可复用时才增加薄任务路由并关闭旧公共入口。仅由 `frontend-v3` 忽略多余字段或隐藏按钮不算完成。

## 2. 用户顺序与实际差距

| Ticket | Owner 可见增量                                                                                                    | 可直接复用                                                                       | 需要适配或新增                                                                         | 明确不做                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 20     | 无登录项目列表；创建、搜索、分页、切换项目；项目内“数据集 / 测试集”；数据集首页                                   | 既有 Project、Owner bootstrap、项目隔离；`frontend-v1/` 的字体、布局、图标与组件 | 新的项目任务查询和原型列表 DTO；复制 donor 到 `frontend-v3/`                           | 登录、成员、设置、项目重命名 / 删除；继续开发 `frontend-v2/`               |
| 21     | 在目标数据集中选择多个 CSV / JSON / JSONL，逐文件映射和预览，整批确认保存                                         | 流式接收、SHA-256、MinIO staging、parser、Parsed View、Source Record、容量与幂等 | Pending Upload、三字段 display mapping、真实预览、confirm / close cleanup              | 责任人 / 用途 / 许可 / 敏感级别表单，高级 parser 工作台，逐文件确认 / 取消 |
| 22     | 数据集文件列表、名称搜索、移动文件；浏览单文件和跨文件统一记录；查看原始内容                                      | Asset、Parsed View、Source Record、locator、分页、集合 membership                | 原型固定展示 DTO、数据集范围联合查询和移动命令                                         | 格式 / 状态筛选、右侧信息面板、目录树、重命名 / 删除数据集                 |
| 23     | 选择数据集 → 文件 → 记录；三列表格增删改；名称和可选用途；创建 `v1`                                               | Test Set、Draft、case CRUD、来源绑定、Candidate 和原子发布                       | Solo Workflow Facade 和原型编辑 DTO；系统生成变化事实                                  | 版本说明、Schema / Recipe / 抽样 UI、重复阻断、治理字段                    |
| 24     | 从任一版本派生；可选追加资料；稳定分支标签；横向版本图                                                            | parent version、case revision、不可变成员和发布事务                              | `publication_order`、`generation`、`branch_number`、`version_label` 及并发分配；图查询 | merge、rebase、改挂父版本、默认切换、归档、任意版本比较                    |
| 25     | 查看父版本、来源资料和逐条增改删；按原型筛选 / 搜索 / 打开详情；下载当前版本数据 CSV 或数据 + provenance 两个 CSV | origin ref、lineage、revision、版本成员、CSV 安全编码与流式下载                  | 面向 Owner 的来源 / 修改摘要 DTO 和两个固定 CSV seam                                   | ZIP / Package、Offline Validator、Langfuse、Delivery 管理、多跳技术血缘图  |
| 26     | 测试集和版本进入 Trash、恢复、永久删除；中间版本保留墓碑关系                                                      | archive 状态、删除闭包、共享引用保护、fail-closed 清理、tombstone                | 原型 visibility / restore / permanent-delete 命令与 Trash 查询                         | 独立 Controlled Deletion 页面、理由、审批、外部副本清单或恢复任务页        |
| 27     | 正式入口完整走通项目 → 数据集 → 上传 / 浏览 → 测试集 → 版本 / 来源 → 下载 / Trash                                 | 既有 Compose、Web / Worker、健康检查和批准的非生产绑定                           | 让 Web 构建与部署只使用 `frontend-v3/`；移除旧前端运行入口                             | 双前端长期并存、`frontend-v2/` 回滚、公网扩面、Production Gate 声明        |

## 3. 数据与接口迁移

| 范围       | 最小迁移                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 项目工作区 | 提供原型所需的 Project 列表 / 创建 / 搜索 / 分页和项目摘要；不增加项目管理能力。                           |
| 数据集     | 复用 `raw_material_collection` 与 asset membership；每项目保留固定“未整理”；UI 统一称“数据集”。            |
| 待确认上传 | 保存 pending state、临时对象引用、expiry、display mapping 和 confirm result；确认前不得创建日常可见资产。  |
| 测试集版本 | 确定性回填并保存 publication order、generation、branch number、version label；不改变既有父关系和成员身份。 |
| 来源       | 聚合现有 record / revision / lineage 事实，不复制第二套溯源真源。                                          |
| 回收站     | 增加测试集 / 版本 visibility 与恢复事实；永久删除复用内部安全清理并按需要保留墓碑。                        |

迁移必须可重复且不得重建既有对象身份、资产 hash、版本成员、父版本或来源事实。

## 4. 必要测试边界

普通 Ticket 只验证当前公共正常路径、一个适用的关键失败 / 边界路径，以及受影响的静态或文档检查。只有迁移持久化、上传确认原子性、版本标签并发、永久删除或正式切换等高风险 seam，才增加直接相关的集成或浏览器测试；不默认运行所有历史 Ticket 和全仓测试。

每张 Ticket 完成后必须停在本地提交和报告处。`ready-for-agent` 只表示规格可执行，Project Owner 仍需逐票明确授权。

## 5. 风险与控制

| 风险                   | 控制                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| 历史前端被误当现行产品 | `frontend-v2/` 明确只读弃用；Ticket 20 从不可变 donor 新建 `frontend-v3/`。 |
| 原型外旧能力重新出现   | 以冻结原型做逐页验收；旧后端能力只能保持不可导航、不可见。                  |
| 新 Facade 复制领域规则 | Facade 只编排既有深模块；容量、发布、来源和删除安全仍由原模块判定。         |
| Pending bytes 长期占用 | expiry 后清理临时对象；关闭或失败不产生 Data Asset。                        |
| 分支标签并发冲突       | 在 PostgreSQL 发布事务中分配；标签发布后永不复用。                          |
| 永久删除破坏后代血缘   | 中间版本保留墓碑与父边；共享对象有未受影响引用时不物理删除。                |
| 新旧前端长期并存       | Tickets 20–26 仅使用独立非生产预览；Ticket 27 一次切换正式运行路径。        |

## 6. 结论

当前无需重做整个后端。最短路径是按 Tickets 20–27 的 Owner 使用顺序复用深模块、补齐任务型接口，并在 `frontend-v3/` 精确实现冻结原型。当前产品下载只包含 CSV，永久删除只使用原型确认，不再保留 Package / CLI 或独立 Controlled Deletion 用户流程。
