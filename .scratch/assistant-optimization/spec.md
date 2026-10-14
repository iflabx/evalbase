# 项目助手实测优化实施规格

2026-10-14 最新文档：[项目助手稳定性与独立工作页面方案](../../docs/assistant-workspace-reliability-plan.md) 已完成，拆为 OPT-20–25 六张。当前均 `Implementation: not-started`；Owner 仅授权方案和 Tickets，不自动开始开发。基线 `f261a79437247349fd8f3e25b49819229ee5741e`，沿用当前工作区；本次未修改应用、切换 4217 或改动验收数据。此前分支合并/推送等授权不自动扩展到新批次。

新增批次的产品细化、依赖、预算与一次最终人工验收统一见 [方案 §10](../../docs/assistant-workspace-reliability-plan.md#10-tickets依赖与交付)。推荐 OPT-20 → 21 → 22 → 23 → 24 → 25；旧 OPT-05/09 及各 Ticket 的 Owner 状态保留，不能由新方案代签。

2026-10-13 最新实施：[OPT-19 数据处理任务列表查询与加载性能优化](issues/19-processing-list-query-performance.md) 已按后续明确授权完成。采用批量摘要、按变化同步和合并保存统计，保留权限、最近范围与分页合同；Implementation completed，Owner pending。同一 4217 Web 固定 `34a0711`；实测、审阅修复和限制见 [验证记录](opt19-verification.md)。

2026-10-13 当前实施：[OPT-18 数据处理失败恢复与清洗、扩写配置优化](issues/18-processing-recovery-and-operation-settings.md) 已按 Owner 要求建立。整合按操作配置、结构化诊断、预算内恢复、去重补齐反馈和部分完成展示；UI 严格对齐 frontend-v1。Implementation completed，Owner pending；同一 4217 已固定 `4af93ad`，检查与限制见 [验证记录](opt18-verification.md)。已有验收记录保持。

2026-10-13 最新实施：[OPT-17 单任务工作区与轻量处理轮次历史](issues/17-processing-task-rounds.md) 已按 Owner 后续开发指令完成，Implementation completed，Owner pending。连续处理在同一任务汇总当前成果，按需查看只读轮次历史，UI 严格对齐 frontend-v1；固定应用 `6c1dafe`、定向验证和同一 4217 切换见 [验证记录](opt17-verification.md)。以下旧实施及验收记录保留。

2026-10-13 既有实施：[OPT-16 数据处理去重补齐、来源说明与列表体验优化](issues/16-processing-deduplication-and-list-ux.md) 已完成实现及定向审阅，Implementation completed，Owner pending。应用固定版本与同一 4217 的切换、去重删除边界、浏览器验证及限制集中见 [实施记录](opt16-verification.md)。当时的 OPT-17 文档限制已由后续明确开发指令解除；旧验收状态保留。

2026-10-13 最新实施：[OPT-15 页面文案精简与信息层级优化](issues/15-ui-copy-and-information-hierarchy.md) 已完成处理页、测试集草稿、设置和助手的重复说明删减及辅助信息折叠，保留关键结果、范围和异常反馈，UI 严格复用 frontend-v1。应用 `214d961`，Implementation completed，Owner pending；同一 4217 的 Web 固定版本、针对性验证及限制见 [实施记录](opt15-verification.md)，既有 Ticket 验收状态不改写。

2026-10-12 最新实施：[OPT-14 页面加载性能与平滑过渡](issues/14-loading-performance-and-transitions.md) 已完成列表减量、按需刷新、稳定布局、搜索防抖与轻量动画，UI 严格复用 frontend-v1。代码 `9d9e3f1`，实施与验证、两轴审阅及 4217 各服务固定版本见 [记录](opt14-verification.md)。Implementation 为 completed，Owner pending；旧 Ticket 及人工验收状态保留原记录。

2026-10-12 最新实施：[OPT-13](issues/13-processing-result-continuation.md) 已完成“结果继续处理、按原输入重新运行、已保存成果入口、草稿来源默认保存回原草稿、来源摘要简化与历史产物名称乱码修复”，UI 严格复用 frontend-v1。Implementation 为 completed；189 项单元、150 项集成、21 项浏览器测试通过，Standards/Spec 复审无剩余 P0/P1。沿用同一 4217，实际范围和限制见 [验证记录](opt13-verification.md)，Owner pending，不改写既有验收记录。

2026-10-11 最新状态：OPT-12 已完成实现、针对性回归及 Standards/Spec 复审，基线 `e257ca1`；同一分支及 4217 环境，Owner 验收 pending。4217 三项应用服务固定 `7d9c8e5`，健康及 Computer Use 现场复核完成；证据见 [OPT-12 验证记录](opt12-verification.md)。

Status: ready-for-agent
Implementation: in-progress

2026-10-09 最新体验实施：[OPT-11](issues/11-processing-workspace-ux.md) 已获授权并完成代码与针对性验证，三项应用服务已固定到 `f8e3579` 并完成环境与浏览器核对；实施及 Standards/Spec 审阅证据见 [OPT-11 验证记录](opt11-verification.md)。Owner 验收 pending，OPT-05/09 历史状态不改写。

2026-10-09 最新状态：[OPT-10](issues/10-fixed-input-and-recovery.md) 已完成实施和复审，应用固定 `4ee577c` 已切入同一 4217 环境；原失败会话沿用固定 200 条恢复至待确认，内容及最终 Owner 验收 pending。实际验证见 [OPT-10 记录](opt10-verification.md)。OPT-09 按验收退回规则记 in-progress，既有证据保留。当前修复与验收状态以本段和下表为准，以下原交付记录不作为最新故障已关闭的证明。

2026-10-09：Owner 授权的 [OPT-09 执行与恢复一致性修复](issues/09-execution-recovery-consistency.md) 已实施、验证并复审完成。最终应用提交 `abc98639b391c958db8e48c67ce4c34f4272e69a` 已统一切入 4217 的三项应用服务；证据见 [OPT-09 验证记录](opt09-verification.md)。沿用当前分支及隔离环境，保留用户资料、失败会话和历史版本；OPT-06–08 历史记录不改写。整个规格仍因 OPT-05 内容交付及最终 Owner 验收未完成而保持 in-progress，不包含合并、推送或正式部署。

2026-10-08：Owner 先后单独授权 OPT-06 和 OPT-07，两张现已实施验证完成；应用提交分别为 `08356cb` 和 `9027332f3b1db8610479e14e3aad6cb64efcb5ef`，详情见 [OPT-06 证据](opt06-verification.md) 与 [OPT-07 证据](opt07-verification.md)。OPT-08 已于 2026-10-08 单独授权并完成实施、通用小样本验证及既有隔离交付；原 200 条内容任务仍未完成，结果见其验证记录；整改批次只有一个最终人工 checkpoint。OPT-01–04 保留历史完成记录，OPT-05 保留未完成状态并映射到后续 Ticket。本次 OPT-08 授权包含既有 Owner 隔离环境的最终切换；不包含合并或推送。

- 历史授权：Owner 曾在持续目标中授权调研、文档、审查、开发、测试及最终 200 条实用测试集；原四项工作连续执行。本次以开头的文档授权与实施状态为准。
- 历史优化基线 `4c71572d79187a0c834f6ef990187c60257ca3de`，工作分支 `codex/assistant-optimization`，工作区 `/home/bistu/EvalBase/.worktrees/agent-data-processing`。基线干净，原隔离环境和历史 200 条版本保留。
- 当前产品行为以 [助手 PRD §7](../../docs/PRD-data-selection-and-assistant.md#7-ai-04-项目助手) 为准；领域含义见 [CONTEXT](../../CONTEXT.md)，执行设计见 [架构 §9](../../docs/architecture/data-selection-and-assistant.md#9-方案执行与预算续做)。[整改方案](../../docs/assistant-remediation-plan.md) 组织实施顺序，测试计划定义验证；早期优化/长任务合同保留未冲突约束和历史证据，本规格只记实际进度。
- 实施时沿用 implement + ponytail full、TDD 和现有公共测试入口；新 Ticket 分别定义首个 red/green，历史缺失恢复验证继续保留。

## 整改批次执行约定

- 文档起点为 `24a7434d3dfb6e03a2c2a1fe0befbca67d948d6f`，应用代码仍为 `65a5055`；沿用 `codex/assistant-optimization` 和现有工作区，不从 main 重建或改写已有开发提交。实施前核对最新 HEAD、工作区和调用方。
- 原整改实施顺序为 OPT-06 → OPT-07 → OPT-08 → OPT-09；最新验收退回由 OPT-10 承接。OPT-10 依赖现有实现，不等待 OPT-09 或 OPT-05 的最终验收，避免循环；OPT-05 不再单独排期，最终收口须含 OPT-09 及 OPT-10 的实际修复证据。
- `ready-for-agent` 表示任务已写清；仍须有开发授权并满足 `Blocked by`。Owner 授权整个整改批次后，前一张满足本张验收及必要审阅即可继续下一张，不逐张要求人工 checkpoint。只授权单张时仅执行该张。
- 每张记录实际提交、直接相关测试、路由处置及剩余限制；历史证据不能代替新验收。前两张通过自动验证和必要审阅可记实施完成并解锁依赖，整个批次的 Owner 验收仍为 pending。沿用 OPT-08 建立、OPT-09 更新的最终 checkpoint；OPT-10 实施后再更新固定版本与证据，共用同一次最终人工验收。
- 所有 Ticket 复用现有权限、数据保护、三字段合同、后台任务及 donor UI。必要的类型/lint/构建、公开正常/关键失败路径和 Standards/Spec 审阅按实际改动选择；P0/P1 阻止本张完成。兼容、并发和权限用可控模型与隔离持久化验证；语义任务使用有限真实样本。
- 只保留一个长期验收项目、管理员与编辑两账号；自动测试另用隔离库/桶。受影响服务切到最终固定版本并核对健康、就绪及前端请求，记录未重建服务的原 SHA/镜像。保留用户资料、失败会话和历史版本；资源回收只处理已确认可处置的本批次资源。
- 冻结原型和 frontend-v1 只读；正式 UI 在 frontend-v3，具体变化按各 Ticket 对齐表及当前助手 PRD。检查通过不授权合并、GitHub 推送、tag 或正式部署。

## 功能与完成台账

| 项目                                                  | 范围                                                           | 依赖                                                  | Implementation | 证据                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| [OPT-01](issues/01-reliability.md)                    | 数量/分类核对、参数解析、保留成功的缺失恢复                    | 已有助手及处理服务                                    | completed      | 缺失恢复/配额/固定范围回归及全量新 200 条核对完成；语义限制见闭环证明                                   |
| [OPT-02](issues/02-integration.md)                    | 多批任务成果、采用同步、溯源下载与中文名称                     | 缺失恢复已验证；独立修复不等待 OPT-01 其他项          | completed      | 七批合为一个资产采用，保留七个真实来源；发布、CSV/ZIP 全量比对通过                                      |
| [OPT-03](issues/03-background.md)                     | 背景附件、持久要求、短提示与同会话连续任务                     | OPT-01/02；文档提取独立进行                           | completed      | PDF/MD/TXT 提取、权限与冻结回归通过；同会话真实 GB PDF 已使用                                           |
| [OPT-04](issues/04-workspace.md)                      | 宽工作区、状态与结果整理、最终 200 条闭环                      | OPT-01/02/03                                          | completed      | 16 项浏览器回归通过；Computer Use 同会话新 200 条闭环完成                                               |
| [OPT-05](issues/05-long-task-execution.md)            | 历史长任务执行与未完成验收                                     | 原功能基础保留；待含 OPT-10 证据的最终 Owner 内容验收 | in-progress    | 历史局部证据保留；不作为新增整改通过证明                                                                |
| [OPT-06](issues/06-active-requirements.md)            | 目标理解、生效要求、规则反馈及摘要                             | 现有 OPT-01–05 代码基础                               | completed      | R06-1–5 通过；应用 `08356cb`；[验证与复审](opt06-verification.md)                                       |
| [OPT-07](issues/07-execution-and-recovery.md)         | 真实步骤推进、后台衔接、成果恢复                               | OPT-06                                                | completed      | R07-1–7 通过；应用 `9027332f3b1db8610479e14e3aad6cb64efcb5ef`；[验证与复审](opt07-verification.md)      |
| [OPT-08](issues/08-review-and-delivery.md)            | 候选审核、通用任务闭环、唯一 checkpoint                        | OPT-07 已完成                                         | completed      | 固定 Web `1aa3707` / Worker `7ed8a3a`；实测及复审见 [OPT-08 记录](opt08-verification.md)；Owner pending |
| [OPT-09](issues/09-execution-recovery-consistency.md) | 当前步骤可执行性、有效依据/范围、失败恢复及真实交付核对        | 待最终 Owner 验收（含 OPT-10 证据）                   | in-progress    | 历史三项服务固定 `abc9863`；[历史验证](opt09-verification.md)保留，Owner 验收退回                       |
| [OPT-10](issues/10-fixed-input-and-recovery.md)       | 固定输入、候选汇总、背景规则与方案恢复                         | 现有 OPT-09 实现；不等待旧 Ticket 最终验收            | completed      | [实施与验证](opt10-verification.md)，原会话恢复；Owner pending                                          |
| [OPT-11](issues/11-processing-workspace-ux.md)        | 数据处理选择、配置、结果核对、保存、助手入口与处理来源展示     | 现有 OPT-10 及页面补修；已获开发授权                  | completed      | [实施与验证](opt11-verification.md)；一个 Ticket、一次人工 checkpoint，Owner pending                    |
| [OPT-12](issues/12-processing-usability-followup.md)  | 配置保留、新建处理入口、任务查找、稳定加载、状态表达与连续核对 | 现有 OPT-11 实现；Owner 已授权开发                    | completed      | [实施与复审](opt12-verification.md)；R12-1–12 Owner pending，UI 严格复用 frontend-v1                    |
| [OPT-13](issues/13-processing-result-continuation.md) | 继续处理、重新运行、保存回来源草稿、来源摘要与历史乱码修复     | 现有 OPT-11/12 及样式补修；Owner 已授权开发           | completed      | [验证记录](opt13-verification.md)；Owner pending，UI 严格复用 frontend-v1                               |
| [OPT-14](issues/14-loading-performance-and-transitions.md) | 列表减量、按需刷新、稳定布局、搜索防抖与轻量加载过渡 | 现有 OPT-13 实现；Owner 已授权开发 | completed | [实施与验证](opt14-verification.md)；同一 4217、一次 checkpoint，Owner pending |
| [OPT-15](issues/15-ui-copy-and-information-hierarchy.md) | 页面文案精简、重复统计合并、辅助说明按需展示 | 现有 OPT-14 实现；Owner 已授权开发 | completed | [实施记录](opt15-verification.md)；同一 4217、一次 checkpoint，Owner pending |
| [OPT-16](issues/16-processing-deduplication-and-list-ux.md) | 去重与有界补齐、真实参考范围、紧凑分页及五类执行筛选 | 现有 OPT-13–15；Owner 已授权本张开发 | completed | 同一 4217、一次 checkpoint，Owner pending；见 [验证记录](opt16-verification.md) |
| [OPT-17](issues/17-processing-task-rounds.md) | 单任务工作区、当前成果汇总、轮次历史与跨轮保存 | OPT-16 已满足；Owner 已授权开发 | completed | 同一 4217；应用 6c1dafe；Owner pending；证据见 opt17-verification.md |
| [OPT-18](issues/18-processing-recovery-and-operation-settings.md) | 清洗/扩写配置、失败诊断、有界恢复及部分完成反馈 | 现有 OPT-16/17 实现；Owner 已授权开发 | completed | 同一 4217 已更新；Owner pending；见 [验证记录](opt18-verification.md) |
| [OPT-19](issues/19-processing-list-query-performance.md) | 列表批量摘要、按变化同步及保存统计减量 | 现有 OPT-14/17/18 及列表补修；Owner 已授权开发 | completed | 同一 4217 Web `34a0711`；Owner pending；见 [验证记录](opt19-verification.md) |
| [OPT-20](issues/20-assistant-diagnostics-and-baseline.md) | 对话失败分类、可行动反馈及固定短请求基线 | 现有实现；仅文档授权 | not-started | 待实现及修复前基线；不以历史错误频率代替当前完成率 |
| [OPT-21](issues/21-assistant-bounded-recovery.md) | 模型请求有限恢复、未知写对账与累计预算 | OPT-20 | not-started | 待定向故障与真实回执验证 |
| [OPT-22](issues/22-assistant-tool-and-plan-contract.md) | 工具按阶段提供、参数减负与要求顺序稳定性 | OPT-20/21 | not-started | 待参数、计划失效与短请求验证 |
| [OPT-23](issues/23-assistant-context-and-background-refs.md) | 当前事实摘要、长会话续用及已验证背景引用 | OPT-22 | not-started | 待长会话、引用真实性及旧数据兼容验证 |
| [OPT-24](issues/24-assistant-independent-workspace.md) | 独立助手页面、个人会话、上下文及既有能力迁移 | OPT-20；推荐 OPT-23 后实施 | not-started | 待真实页面及权限/加载验证；UI 严格复用 frontend-v1 |
| [OPT-25](issues/25-assistant-task-results-and-delivery.md) | 整任务成果审核、局部调整与确认交付闭环 | OPT-21/22/23/24 | not-started | 待整任务范围及最终固定样本；集中一次 Owner 验收 |

长任务的历史范围见 [方案执行与长任务恢复](../../docs/assistant-long-task-execution.md)。当前整改按本规格开头的文档职责执行。OPT-05 与整改批次的最终 Owner 验收仍未收口；OPT-10 补修后仍复用同一最终 checkpoint，不改写历史验证记录。

OPT-12 是 OPT-11 后续体验调整，Owner 已单独授权开发；不等待旧 Ticket 的最终人工验收才允许编写或后续获授权修复，也不把本张文档变更记作旧验收通过。本次实施沿用同一分支和 4217 隔离环境，一个 Ticket、一次 Owner checkpoint。

## 验证矩阵

下表保留原 OPT-01–04 的验证编号；R06/R07/R08 及后续补修 R09/R10 验收分别记录于各 Ticket，详细用例统一引用 [测试计划 §5](../../docs/test-plan-data-selection-and-assistant.md#5-整改验收计划)。

| 编号    | 要求                                                         | 权威证据                                          |
| ------- | ------------------------------------------------------------ | ------------------------------------------------- |
| REL-1   | 缺失输出不能算数量达标，重试只补缺失并保持成功候选身份/内容  | 真实 Worker + 假模型 + HTTP 回归                  |
| REL-2   | 分类及配额按完整有效候选计算；语义审核不伪装自动通过         | 服务端核对/HTTP + 真实模型内容复核                |
| REL-3   | 短请求自动解析明确范围，歧义不会扩大来源                     | 真实 SDK 的助手 HTTP 回归与浏览器                 |
| FLOW-1  | 同会话多批汇总、局部调整替代而非重复计数                     | HTTP 持久任务及确认回归                           |
| FLOW-2  | 多批作为单一任务成果采用，仍保留各批来源与容量               | 真实数据库/对象存储 + 发布来源回归                |
| FLOW-3  | 两处采用状态一致及幂等，两个下载确实为不同内容，中文名称正常 | HTTP/CSV + 正式浏览器下载                         |
| DOC-1   | PDF 中文文字、页号；MD/TXT 行引用；文档要求可纠正并持久      | 提取测试 + HTTP + GB 附件实测                     |
| DOC-2   | 文档权限、容量、撤权及删除清理                               | HTTP 持久化安全边界                               |
| UI-1    | 宽工作区、同会话加载、进度和下一步、结果审核及恢复           | 桌面/窄窗口浏览器截图和语义检查                   |
| FINAL-1 | 单会话、短请求及两份资料创建并发布新 200 条可用测试集        | 真实 Qwen + Computer Use + 全量读取/内容复核/导出 |

## 架构约束

保留 AI SDK 与 PostgreSQL/MinIO/Worker；不引入第二智能体平台。缺失恢复在 processing 批次边界统一修复。文档为会话背景，引用由服务端映射，运行冻结摘要。多批有效结果清单与现有任务关联，采用仍复用领域校验及事务幂等。具体变更和新路由先记录于当前项目，最终再更新架构与测试计划入口。

## Comments

- 2026-10-06：已核对基线、技能、权限范围和运行隔离；研究完成，开始缺失恢复的公开反馈循环。四项尚未完成，不以计划代替实现证据。
- 2026-10-06：REL-1 公开处理读取/status 显示缺失条数，旧 succeeded 缺失任务在处理页和助手均可重试；成功内容/身份保留。分类允许值和精确配额进入持久计划，服务端完整核对并展示差额，空问题/重复不算结构完整，语义仍需审核。
- 验证日志位于执行机 `.scratch/assistant-optimization/`：`missing-count-green.log`（3 个恢复案例）、`legacy-task-recovery-green.log`（助手旧任务恢复）、`reliability-adoption-regression.log`（33 项）、`classification-public-green.log`（分类计划→真实结果→采用同步）、`recovery-and-download-browser.log`（3 项，ZIP 双内容、来源页入口及失败不下载）、`classification-assistant-browser.log`（10 项）。运行时代码尚为旧固定 HEAD；本轮无新 200 条结果，不标记 OPT-01/02 或总体完成。
- 短请求公开 SDK/HTTP 回归：随机选一条后，同会话后续复用相同范围，不向模型暴露完整 ID 清单；换来源不扩大范围，来源修订变化拒绝继续使用旧快照。日志 `short-scope-complete.log`；后续真实模型与最终闭环仍待验证。
- DOC-1/2 后台进展：新增 PDF/MD/TXT 个人背景的保存/刷新/定位读取/移除；真实 Worker 请求携带原文位置、哈希与持久用户纠正。GB PDF 31 物理页、附录 A 五大类及全部 31 项验证通过，字体与字符映射只读包内文件。跨账号、撤权、五份上限及个人背景运行隔离已过 HTTP 检查（`background-private-run-green.log`）；前端入口、多批汇总和新 200 条闭环仍待完成。

- 2026-10-06 最终复审：Standards 与 Spec 的 P0/P1 已全部修复并窄范围复核通过。67 项受影响后台回归、16 项浏览器回归及类型/lint 通过；最后两处非首条候选去重、旧批次恢复仅重跑直接受影响 8 项，全部通过。真实模型单会话新 200 条闭环尚未完成，不标记实施完成，不替代 Owner 验收。

- 真实短请求恢复补修：无效计划后仍允许查询来源/读取背景，保留未执行义务；公开 SDK redgreen（2 项）、类型和 lint 通过，双向窄复核无新问题。日志 `real-flow-plan-recovery-red.log` / `real-flow-plan-recovery-green.log`。

- 同会话真实模型首轮完成 200 条，实际配额 105/37/58，Metadata 键与编号不统一，尚未采用或发布。继续按实际结果修正；不能把候选数量达标视为内容通过。补充运行中已保存数量及扩充目标，扩充状态 HTTP redgreen、浏览器回归、类型/lint 均通过；分类纠正说明明确清旧标签与替换规则，省略会保留旧值。

- 后续真实 200 条逐题期望输出已改善，但配额为 133/23/44，风险编号仍不合格。追踪到各批重复接收全量配额；新增冻结分类与本批数量提示，扣除已接受输出，保护部分调整和不可修改字段。`actual-batch-quotas-red.log` / `actual-batch-quotas-green.log`（6 个定向检查）及类型/lint 通过。真实回执与失败计划残留的正常结束、中断恢复已 REDGREEN；恢复不再调用模型，也不重复提交。最终结果仍待真实核对。

- 真实整批修正发现未勾选候选却使用 allSelected，参数失败后读取旧结果被错误标为成功。已保留提交/调整的未执行义务，提供真实范围恢复提示；公开 HTTP redgreen、六项失败/旧回执恢复及类型/lint 通过。长验收标准统计默认折叠，先显示候选表。真实新任务仍待继续，尚未采用或发布。

- 同一义务修复的跨工具及中断边界已完成：失败后仅计划/读旧结果不能解除处理义务，经校验的真实提交或调整回执可解除；正反回执持久化后恢复保持同一运行、零模型调用。六项窄回归、类型/lint及双向复审通过，无明确剩余P0/P1/P2；尚待真实200条内容闭环。

- 真实全批候选调整产生大量unknown_source，已停止该轮且未采用。定位到模型输入同时包含当前与历史编号；新增processing-v3映射数据投影，旧v1/v2保持wire与批次身份，冲突/真实溯源字段仍留服务端。baseline误选的公开Worker redgreen通过，配额与旧配方回归、类型lint在收尾；真实新200条仍待继续。

- 后续真实多批发现旧批次已完成会反复触发仍在运行任务的完成核对；聚合触发条件改为全部关联批次已结束，排队/执行/终止失败及重复轮询公开回归先红后绿。补充明确计划参数失败恢复和章节定位提示；新processing-v4保留映射投影并明确温度0.2，v1/v2/v3重试保留原参数。真实生成的错配编号、乱码及不完整结果均未采用，最终200条尚未完成。

- 真实 200 条扩写出现连续批次超时，已停止且未采用。新增 processing-v5：超过 20 条的扩写按每批 10 条输出，并发送整体位置 offset/count/total；v1v4 的既有请求、分批和修订身份保持原状。公开 Worker 回归先红后绿，验证 21 条按 10/10/1 分批、结果唯一，v4 仍按 20/1；缺失补齐及分类配额的 4 项窄检查通过。真实新 200 条仍待重新生成和审核。

- v5 末批预算复审 P2 已定位并补公开回归：新配方按本批真实数量预算，v1v4 保留原估算。39,999 字节的最后单条扩写请求先因错误估算被拒（RED），修正后可以发送且仍不超 40,000 字节。真实候选尚未采用，最终闭环继续。

- 2026-10-08 后续审查：在固定 `a5e7815` 核查最新失败回合和相似代码路径，新建 OPT-09，统一跟踪执行依赖、有效依据/范围、失败恢复、字段保护和实际发布核对。当前只完成审查和任务文档，实施未开始；OPT-05 收口依赖同步更新，历史完成记录保留。

- 2026-10-11：Owner 要求把两轮数据处理体验建议合并为一张修改 Ticket，新增 OPT-12 及 PRD §6.4 引用；仅文档修改，尚未授权开发，原 checkpoint 和历史状态保留。

## 最新完成记录

2026-10-06：四项实施完成，最终代码 `65c10e9b683928765a9a8d7f3a3d3da6213b26fe`，之前 Comments 为按时间追加的历史进展。真实新 v1 共 200 条，分类 100/50/50，24 条操作人员内容修正；CSV/ZIP 和全部来源已核对。Standards/Spec 最后窄复审无 P0/P1/P2，发布完成/回执恢复/下一任务共 3 项公开回归、类型/lint 通过。详见 [闭环证明](verification.md)。Owner 人工验收尚未代签；不合并、不推送、不正式部署。

- 2026-10-08：按 Owner 要求拆为 OPT-06–08 三张功能 Ticket，依次实施、同批验收。当前仅完成任务文档与依赖整理，所有新增验收项 pending；未修改应用或切换环境。

- 2026-10-08 OPT-08：候选来源/差异和真实下一动作已实现；实测补修固定步骤衔接、简单要求替换旧待执行方案、采用后的来源核对。实际验证和剩余限制集中记录于 [OPT-08 验证](opt08-verification.md)，Owner 人工验收 pending。

- 2026-10-08 OPT-08 实施与最终交付完成：通用小样本、目标式请求、来源对照与唯一发布闭环见 [验证记录](opt08-verification.md)。4217 沿用 1 项目、2 账号；Web `1aa3707`、Worker/Model Worker `7ed8a3a`，健康与实际浏览器请求通过。原 200 条复用后核对未通过、保存方案尚未实际执行；不把旧内容未完成改签为成功。整改批次 Owner checkpoint pending，OPT-05 保留原未完成状态，无合并或推送。
- 2026-10-09 OPT-09 实施与验证完成：当前依赖、无副作用纠错/未知写保护、有效范围/背景、最初字段基线及实际发布核对已补修，三项服务固定 `abc9863`。同会话三条短提示的通用 6 条任务完成唯一发布；既有失败会话完成只读恢复并清除过期提示，原 200 条候选哈希不变。详细证据和范围见 [OPT-09 验证](opt09-verification.md)，最终 Owner checkpoint 及 OPT-05 内容交付仍未收口。

- 2026-10-09 OPT-10 实施收口：固定输入、有效候选与确认范围一致，文档依据及用户兜底受校验，参数错误可有界纠正；原会话必要重做同一 200 条分类并自动到采用卡，未采用/发布用户数据。最终应用 `4ee577c`、16 项定向 green、三服务及浏览器证据见 [验证记录](opt10-verification.md)。OPT-10 Implementation completed；整个批次、OPT-05 内容交付及 OPT-09 Owner 退回验收仍 pending，历史记录保留。
