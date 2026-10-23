# OPT-50 全链路及字段证据索引

固定实现：be2b8b1ff7e1edbddce2cfe95617dd10908fd5ba。字段逐项索引见[90字段JSON](tool-field-index.json)；历史字段语义及399条复用路径仍见[原审查](../tool-contract-audit-20261023/field-matrix.md)。本索引不复制第二份运行时Schema。

## 证据口径

全部15工具/90顶层字段已逐项关联当前声明、共同准备/绑定、纠错、恢复和适用确认入口。以下正负例按共同字段合同和公共流程族复用，不声称每个字段全排列均独立运行。OPT-46/47/48/49的177/247/170/170是各自历史采用证据，存在重叠，本轮不相加或重跑。当前58项只计13页面+44公共状态/反馈+1精确恢复。

CU10仍失败；全工具静态接线不能替代实际纠错→澄清闭环，因此R50-8/9不能以此索引签整体通过。真实首错及工具输入在[CU事实](cu-proof.json)，关闭预算见[campaign](campaign/budget.json)。

## 工具正负例索引

| 组 | 实际工具 | 正例/反例与已采用证据 |
| --- | --- | --- |
| A | plan_task | OPT46 completion公开direct/sdk 3+2、1/2场景、重复核对；缺id/定义改写/场景/容量拒绝。见[46清单](../opt46-completion-20261023/verification-results.json)。 |
| B | read_background | 46初始合法分类和真实引用读取、非法definition/附件删除失效；48按任务权限及别名边界。 |
| C | query_project | [47清单](../opt47-development-20261023/summary.json) bounded discovery、live visibility/撤权；本轮CU10实际project混search/offset及后续files/drafts已查到仍未澄清，保留失败。 |
| D | read_records | 47真实随机选择→固定seed/ID→提交；bad selection conditions、跨来源范围和明确2条但源3条拒绝；48 customerId/别名普通值保留与未知引用拒绝。 |
| E | create_draft | 47先检查条件再同名复用、不忽略新purpose；48[旧夹具补修](../opt48-development-20261023/legacy-fixture-followup/summary.json) current/legacy持久回执复用及独立任务同名隔离。 |
| F | preview_selection | 47 data-selection公开预览分页、固定抽样、应用一次；更改revision/source、跨用户和容量失败回滚；预览不等于全量授权。 |
| G | generate_candidates | 47草稿已提交/运行未提交三个切点及运行提交后丢响应；46合法场景数与定义保护；未知/部分提交不释放原identity。 |
| H | submit_processing | 47 selected two-row file cleans exactly once、saved step shares direct compiler；combined clean/config/range errors、false/null/冲突及只预览不授权。 |
| I | select_candidates | 47真实seed/ID及省略seed再选复用；嵌套seed冲突/非法条件/分类不足，既有assistant-candidates合同。 |
| J | refine_candidates | 47 equals/contains真实大小写空白/Metadata键一致，显式allResults不另补allSelected；candidate changed content/run拒绝；不能借其他来源。 |
| K | retry_processing、read_processing | [49记录](../opt49-verification-20261023.md)已提交/未知回执对账、无进展/段预算拒绝、读取页码不产生进展；[48记录](../opt48-verification-20261023.md)历史读取不推进新任务、旧只读不迁移。 |
| L | request_selection_apply、request_processing_apply | 47 selection apply revision/replay/source/actor负例及explicit false不改范围、target条件准备；48旧任务确认失效，实际固定回执。confirm不接受模型再次填写字段。 |
| M | request_publish | 48原8项修复中的固定确认发布/回执重放：确认前零版本、确认后唯一版本；旧任务确认409、撤权不发布。没有重新运行真实发布。 |

## F01～F12 当前接线与退出路径

| 发现 | 当前实际调用方和旧路径边界 | 有效证据/当前结论 |
| --- | --- | --- |
| F01/F02 | preparePlanProposal（plan-preparation）供普通/SDK/业务失败准备；可信id绑定后派生数量，写事务重检 | 46公开3+2 direct/sdk/连续新错误；CU7本次amendment被临时门禁误拦，不能给真实修改通过结论 |
| F03 | argumentRepair更新当前候选/最新issues，保留首错与原限额 | 46第二次SDK新问题回归；CU10普通调用仍暴露未闭合，不能写所有纠错稳定 |
| F04 | prepareToolProposal贯通direct/plan/repair；bounded discovery保留真实来源问题 | 47处理公共族通过；CU10实际查询错误纠正/澄清失败，需回所属机制处理 |
| F05 | operation提交阶段及复合回执；partial/unknown先对账，不能按最后validation错误释放 | 47三种部分提交及响应丢失，49继承固定操作输入 |
| F06 | task-boundary/store的任务身份/SQL过滤；本票restoreTaskId精确选中同会话快照 | 48 120条合成历史/旧权限/迟到确认；本票同名任务实际HTTP恢复及13项页面 |
| F07 | 最终出站容量统一，保留当前合同和必要指代，不能仅裁块或猜token | 48 9/20长要求及8192窗口零发送容量拒绝，复用原证据 |
| F08 | budget-ledger/transport的真实预留/结算、完整正文与解析计时 | 49已发送/未发送/慢体/重试/未知结算；本轮门禁实际18外发另记，未重置原账 |
| F09 | progressFacts/recovery由状态、queue、agent共同消费；新版本不以query正文变化续段 | 49跨至少3段和无进展拒绝、读取页码时间不推进；本轮44公共状态/反馈 |
| F10 | server feedback→工作卡/消息失败/授权入口；旧回合不盖当前成功 | 本票13UI含409、历史迟到、完成+旧错；CU7门禁异常后的409与pending提示仍需故障类别联动复核，不标全状态通过 |
| F11 | 跨入口公共夹具+页面控后端+固定真实CU分开计数 | 本轮58项通过，真实两项未通过；首次错误和基础设施失效保留 |
| F12 | 当前状态文档仅指向唯一验证记录；既有120历史/批量依赖与锁范围复用 | 文档台账更新，不宣称做过性能压测或任意长聊稳定性证明 |

## TP01～TP08

TP01/02/03/04/05/07用47的共同准备、范围互斥、seed/条件、create/target分支及public preflight正负例；TP06用46方案场景/定义和48完整要求/真实载荷容量；TP08用49旧operation维持原合同、显式变化不复用/不重算旧hash的隔离兼容断言。旧合同不批量迁移，未扫描旧数据来声称风险线上曾发生。

本次不改写前票历史通过事实；新CU10暴露的问题意味着“参数校验会拒绝”与“模型纠错后能完成业务”仍须分别证明。当前R50-5、R50-8/9整体验收保持未通过；后续验证不得复用本次关闭额度。
