# 项目助手全工具参数传递审查（2026-10-23）

## 1. 范围、基线与结论

这是[全链路审查](assistant-full-review-2026-10-23.md)的逐字段补审，不替换原F01～F12及历史验收结论。

- 服务器工作树：`/home/bistu/EvalBase/.worktrees/agent-data-processing`；分支`codex/assistant-optimization`；文档基线`a4102b78545eaf11d1e8b782b127330c662ab43d`。业务源码与最近部署记录`2c74b8e23d2b80770fd039f244da38d34f03f3b2`相同。
- 枚举全部 **15个businessTool、90个顶层字段**；抽取包括复用Schema和计划action变体在内的399条字段路径。逐项清单见[字段核对表](../.scratch/assistant-optimization/tool-contract-audit-20261023/field-matrix.md)，精确条件和数组元素约束见[Schema快照](../.scratch/assistant-optimization/tool-contract-audit-20261023/tool-schemas.json)。399是路径条目数，不是不同业务字段数或通过测试数。
- 核对模型声明、固定执行校验、计划输入、上下文补齐、业务服务、冻结回执、确认接口和恢复；包括缺省、null、false、空集合、互斥字段、数量/长度、引用身份及范围。
- 本轮新增 **7组代码确认的问题（TP01～TP07）**，另列 **1项旧冻结合同兼容风险（TP08）**。14条离线探针观察中含反证及风险边界，不是14项应用验收通过。探针无数据库、网络或模型调用，未重跑任何验收任务。
- 这些结果说明“工具Schema来自同一份声明”仍不足以保证完整业务合同一致；可保留现有SDK、业务服务和确认边界，收敛参数准备、错误及冻结身份的解释，不新建另一套编排框架。

不能据此保证任意文档、模型和参数组合零缺陷。未进行真实并发、运行态故障注入、长对话或性能测量；静态风险与已确认不一致分别列出。业务代码、现有数据、旧预算及已完成结果均不改动。

## 2. 调用入口与安全边界

| 入口 | 当前实际行为 | 结论 |
| --- | --- | --- |
| 模型直接调用 | `businessTool`生成声明；source/runId/draftId/previewId/allowedFields/instructions等可由当前事实补齐，补齐后执行固定AJV校验 | 模型必填与执行必填不同是有意设计，不能简单全部改必填；需保证补齐有可信唯一来源 |
| 旧计划/非文档计划 | 14种action输入从对应工具Schema派生，未来依赖可缺省；执行前绑定回执并重新校验 | 计划输入暂时不完整是必要能力；尚无依赖须等待，不能把未知字段填假ID |
| 新文档deliveries | 新建/修改/删除合同，服务端编译生成、核对、确认步骤；增量、首次、旧文档分不同Schema | 保留有版本的兼容，修复F01～F03；新增TP06的场景数量冲突不能靠暗增场景解决 |
| SDK及业务纠错 | 确定性格式归一、两次有界修复、约束保护；目前不同错误来源提供的字段问题精度不同 | 未知额外字段不会任意删除；不把allSelected纠成allRecords。TP01/07补齐准确错误 |
| 计划派发/恢复 | `advanceExecution`先绑定和预检，再调用同一businessTool；步骤及已启动回执另做参数比较 | 同工具接线确实存在；不等于两次绑定、比较和业务校验的语义已统一，TP08核对旧参数边界 |
| 采用/发布确认 | 三种request工具只建卡；confirm仅接受空body，按固定parameters、digest、task revision、lease和目标revision执行 | 确认并非让模型再次填实际写入参数。保留原权限、失效和原子回执保护；本次未发现新增绕过 |

主要定位：`agent.ts:1514–1600,1682–1907,5650–5829,5854–6070`；`plan.ts:714–937`；`tool-repair.ts:283–336`；`server/modules/assistant.ts:515–783`。行号固定于本次业务基线。

## 3. 逐工具闭合摘要

每个顶层字段和嵌套字段已在字段表列出；此表只索引校验、恢复与问题归属，不另维护参数合同。

| 工具 | 顶层字段数 | 业务校验/回执及恢复核对 | 本次结果 |
| --- | --- | --- | --- |
| plan_task | 19 | 可信目标、修订、分类定义、增量合并、保存/核对；所有规划/纠错/补保存入口 | F01～F03继续修；TP06；TP08风险 |
| read_background | 7 | 会话文档、三片段窗口、独立目录游标、选用证据和12片段上限 | 边界基本对应；空白query属TP06；已读/选用不能混淆 |
| query_project | 4 | 权限过滤、20行分页、草稿写权限、发现依赖 | TP05无关字段被忽略；F04/F06保留 |
| read_records | 7 | source校验、固定范围、分页与全量统计；执行意图才持久选取 | TP01/02/04/07 |
| create_draft | 5 | 新建/基于版本创建、同名复用、幂等创建回执 | TP05；不把复用当成应用了新purpose |
| preview_selection | 7 | 草稿/原始文件、预览配置、范围摘要、草稿配对 | TP01/07；错误在selection服务已有转换，不能笼统称所有入口都无转换 |
| generate_candidates | 8 | 当前背景、交付定义、处理预检、目标草稿和运行两个提交点 | TP06/07；F05部分提交对账仍由OPT-47负责 |
| submit_processing | 10 | source/范围/操作/字段/键/数量、冻结哈希、处理回执 | TP01/02/06/07；F04/F05 |
| select_candidates | 4 | 当前任务全部候选、selection/groups、集合冻结、统计 | TP01/03/07；多组顺序选取已有正确实现 |
| refine_candidates | 7 | 四种范围、当前候选、有效resultRef、字段保护、分组精修事务 | TP02/04/06；Metadata键仍在freezeBackground校验，未证实保护绕过 |
| retry_processing | 1 | 服务端读取恢复能力、已完成只对账、只重试失败批次 | 本次未确认新增字段缺陷；F08～F10共享恢复继续覆盖 |
| read_processing | 2 | runId/事件限制、全任务核对、offset只分页预览；会更新review/stage | 未确认新增字段丢失；F06/F09须避免历史读取改变新任务执行事实 |
| request_selection_apply | 2 | draft/preview成对、固定selectedIds和revision、用户确认 | 本次未确认新增缺陷；来源变化、失效修订仍须负例回归 |
| request_processing_apply | 6 | 当前候选范围、target、固定resultGroups/resultsGuard与目标修订 | TP02/05；真实确认前不写目标 |
| request_publish | 1 | 实际草稿数量/修订、真实候选核对、发布确认 | 本次未确认新增缺陷；计划/工具/确认不等于已发布 |

## 4. 问题与责任票

### TP01 · 选择参数的必需条件和补齐入口不一致（P1，已复现/代码确认）

共享selectionSchema只要求method；random要求value但不要求mode，conditions可省略。实际selectRecords必须有conditions数组、random必须有mode，Metadata条件必须有key，equals/contains必须有非空value。submit_processing/select_candidates通过selectionParameters补conditions并在value等于当前目标时补count；read_records不走相同补齐。preview_selection另用扁平Schema，也未表达相同跨字段规则。

同一合法外层提议因此可能直接读失败、提交时成功，或错误推迟至业务函数才出现。探针P02～P04证明声明与纯选择函数/绑定结果差异。不能一律把缺mode的数字解释为条数，单位仍须可证。

定位：`agent.ts:214–256,3428–3441,4151–4175,4355–4378`；`plan.ts:808–846`；`selection/index.ts:36–85`。修复：OPT-47统一选择准备；OPT-46提供共同字段问题/修复结果；错误分流见TP07。

### TP02 · 显式范围被忽略或被已有勾选改写（P1，已复现/代码确认）

- read_records同时有selection和顶层conditions时只使用前者，后者静默不生效。
- submit_processing拒绝selection混recordIds/allRecords，但接受recordIds＋allRecords:true且使用recordIds。
- refine_candidates显式allResults:true且存在任务勾选时，bindTaskInput另补allSelected:true，后续互斥检查拒绝；即使不补，也有现有勾选保护，不能仅删除检查来强行扩大范围。
- request_processing_apply中已有任务勾选可以把显式allSelected:false改为true，并使allValid分支不生效；allValid＋resultIds在非整任务分支采用IDs。最终仍需要用户确认，本次没有证明未确认写入，但参数、授权范围和卡片预期可能不同。

定位：`agent.ts:4213–4239,4674–4716,4944–5003,5352–5394,5486–5505`；`plan.ts:885–901`；探针P05/P06。OPT-47将各范围模式明确互斥，冲突返回一个具体范围问题；只在省略且可信唯一时补齐。不能把显式false当缺省，不能忽略用户条件，也不能自动把勾选扩大为全量。OPT-49冻结原准备结果并统一恢复。

### TP03 · 顶层随机种子没有用于selection分支（P2，已复现）

selectCandidateRun的顶层seed用于groups派生子种子；selection分支直接把input.selection交给选择器，未注入顶层seed，却把顶层seed写进候选范围记录。只传顶层seed时底层自行产生随机seed；同时传不同的两个seed时，保存与实际抽样身份不一致。现有单位测试仅验证groups＋seed的确定性，不能覆盖此分支。

定位：`candidates.ts:91–155`；`tests/unit/assistant-candidates.test.ts:73–102`。探针P07/P08使用注入选择器观察传入配置，不声称已测随机分布或数据库重放。OPT-47确定唯一有效seed和冲突规则；OPT-49冻结真实使用的seed/范围，不为旧记录猜补。

### TP04 · 相同筛选条件在精修与选择中含义不同（P2，代码确认）

selectRecords对文本/value trim并忽略大小写，Metadata必须明确key；refine_candidates.where采用原样equals/contains，key缺省匹配任意Metadata键。对于大小写/首尾空白或缺key的相同条件，两条路径结果不同，工具说明没有交代此差异。

定位：`selection/index.ts:94–113`；`agent.ts:4911–4920,5029–5048`。OPT-47复用现有条件语义，不能新增无授权“全Metadata键搜索”捷径；旧已固定IDs保持不动。用真实不同大小写、空白和多键夹具验证匹配集合，而非只比较Schema。

### TP05 · 条件字段只在部分业务分支校验，其他分支静默丢弃（P2，代码确认）

- create_draft中testSetId和parentVersionId在底层必须成对且不能混name/purpose；工具Schema未声明。会话同名复用在command前返回，可让不完整testSetId或新purpose被忽略。不是未授权写入，但可能把未应用参数的复用结果误称为新要求已完成。
- request_processing_apply.target仅要求kind；draft缺id/newDraft缺name后置才发现；asset等分支额外name/id/purpose可被忽略。
- query_project的testSetId只用于versions，project分支不使用search/offset；缺少按kind区分的字段约束。

定位：`agent.ts:4074–4147,4295–4338,5322–5334,5443–5465`；`drafts/create.ts:87–103`。OPT-47在复用/副作用前做条件准备，保留明确复用能力，反馈哪些操作实际发生。已保存不相关purpose不自动覆盖；不增加新的编辑工具或公开API。

### TP06 · 语义归一、容量与场景约定在层间漂移（P1容量 / P2其他，已复现/代码确认）

- plan_task可保存20项、每项1000字符requirements；执行时bindTaskInput整段拼成instructions。探针9项1000字符得到9008字符，计划声明合法而submit_processing的8000限制拒绝。不能通过截断有效要求过关；当前代码会拒绝，不会把超长指令无校验送入处理服务。
- 空白instructions/query、Metadata键按trim/大小写重复、场景trim后重复，外层结构通过但下层语义拒绝；需要在共同准备时一次给出准确问题。refine instructions的2000上限与处理服务8000是接口子集，不单凭不同数值认定缺陷或要求统一放大。
- generate_candidates接受至少1个场景，文案明确用户指定场景数量优先；新deliveries Schema和reviseDeliveryGoals却要求至少3。明确只要1～2个场景的请求因此存在合同冲突。“生成2条”不等于“只允许2场景”，两者必须分开。

定位：`agent.ts:2467–2472,3967,4439–4462,4625–4638,4922,5683–5685`；`plan.ts:902–910`；`delivery-plan.ts:897–907`；`processing/protocol.ts:51–135`；探针P09～P11。OPT-46统一当前方案场景优先级和派生规则；OPT-47在处理准备校验完整配置；OPT-48把有效要求与简短执行指令分开投影、按最终载荷核算，保留冻结完整约束，不新增总结模型链或默认加大上限。

### TP07 · 参数错误被泛化，修复提示引用了错误操作合同（P1，代码确认）

read_records的顶层conditions和select_candidates调用纯selectRecords时，纯Error('selection_invalid')没有code；通用catch转成assistant_operation_failed，失去字段原因。fixedSelection已有processing_scope_invalid转换，预览服务也有SelectionError转换，所以不能称所有选择路径都缺恢复机制。fixedSelection当前统一提示缺mode，也不能准确解释缺key/value/conditions。

通用processing_configuration_invalid提示写“outputCount只用于augment”，generate_candidates也可能经该错误分支，但generate实际必须有outputCount。这样的纠错指令会让模型修改本来正确的字段。确认卡和旧预算保护依然存在，这些是错误表达与有限纠错闭环缺口。

定位：`agent.ts:983–1043,2286–2292,2388–2402,4232–4239`；`selection/store.ts:101–105`；`candidates.ts:118–122`。OPT-46/47用实际tool/operation/fieldPath给出新错误，不扩大修复循环；OPT-49保留原问题及真实未提交/未知效果；OPT-50展示正常业务原因，内部Schema文字留诊断。

### TP08 · 旧冻结参数与规范化结果比较（P1静态风险，尚未证实线上触发）

人工构造旧计划省略selection.conditions/mode，执行绑定后的合法参数与原step.input不同，原样比较可拒绝。正常新计划保存已经在agent.ts:3428–3441归一；**不能把此探针当成当前新计划必失败的证明**。本次没有扫描/修改验收库来证明存在这类旧行，也未重放旧会话。

定位：`plan.ts:714–783,808–846`；`agent.ts:1682,1794–1807,1847–1889`；探针P01。OPT-47/49用持久合同版本与旧冻结回执做隔离兼容测试，规范化应先于新操作指纹计算。未知副作用先查回执；不能以重新计算旧hash或扩大范围解决恢复。已有保护断言覆盖的格式应保留，若隔离测试证明该路径不可达，记录反证关闭风险。

## 5. 已排除与应保留的设计

1. 引用codec按id/ref字段名遍历存在扩展风险，但实际Metadata是key/value数组，customerId作为key值不会变成对象属性；本轮未证实Metadata被错误编码，不列为已确认漏洞。背景definition引用也不等于业务对象ID。后续如改变数据形状，补回归而非先改codec。
2. schema模型侧移除uniqueItems是兼容解码器；固定AJV仍检查唯一性，不能为统一声明而取消执行保护。
3. submit_processing.selection:null兼容“复用同源固定范围”，不表示全量；普通null、显式false、空数组须按各字段本义处理，不能全局清除。
4. refine没有metadataKeys参数不等于失去键保护：freezeBackground→validateProcessingRequirements仍限制。以实际事务路径验证，避免新建重复保护机制。
5. 计划缺未来runId与执行缺runId不同；确认必须从匹配交付回执绑定，不能强制模型预测ID。跨用户/项目、失效版本、修订、hash与目标范围保护继续保留。
6. background读取、候选核对虽然名为read，也可能保存选用证据或状态；任务边界和进展判断沿F06/F09由OPT-48/49收敛，不能只按工具名猜是否发生业务变化。

## 6. 测试覆盖与完成边界

现有测试覆盖了计划依赖配对、错误参数不能扩大范围、groups固定种子、候选精修回执、确认后置和版本围栏。缺口集中在“同样参数经不同入口”以及省略/显式false/既有勾选/下层错误的组合；已有测试数量不能证明这些路径通过。

完整可观察标准在OPT-46～50；场景索引见[测试计划§5.21](test-plan-data-selection-and-assistant.md#tool-parameter-tests)。开发时用已有SDK/HTTP/业务服务测试夹具验证15工具的声明→准备→调用→恢复；无需全部参数全排列，不新增通用测试平台。每组问题记录对应源码调用方、固定失败夹具、实际出站合同、持久范围/回执、旧路径退出与兼容结论。

本轮只更新审查和开发文档。OPT-46继续in-progress/partial-pass；OPT-47～50保持not-started。真实CU仍只按OPT-50既定第7/10项及原限额集中进行，本次不授权启动、追加或重置预算。旧400/248条、旧会话和已完成部分不重跑。
