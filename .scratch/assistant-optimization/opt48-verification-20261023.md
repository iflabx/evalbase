# OPT-48 实施与定向验证（2026-10-23）

## 基线与结论

- 工作目录：/home/bistu/EvalBase/.worktrees/agent-data-processing；分支 codex/assistant-optimization。
- 固定基线 db7ebe0；实现及回归提交 **83e7d3d0f5193b1080268c6d6d32e9a49548fb9f**。后续文档提交不改变运行代码身份。
- Implementation completed / Validation targeted-pass / Owner pending。**160项不同定向用例通过**，按测试文件和完整用例名去重，不累加重复运行、跳过项或历史验收。逐项最终采用证据见[机器清单](opt48-development-20261023/summary.json)。额外旧夹具的8项失败单列于下文，不能宣称全仓测试全绿。
- 本轮未更新4217、调用真实模型或Computer Use、合并main、推送或打tag。4217最近部署记录仍2c74b8e；OPT-49/50未实施，原第7/10项和248/400条结论保持。

## 实际责任与退出路径

| 责任 | 实际接入与旧路径处置 |
| --- | --- |
| 稳定任务身份 | 当前session.task保存taskId/taskContractVersion，turn明确归属任务；新格式不再以session永远等于一个目标。继续、改名、数量、局部主题修改沿原身份；新增独立目标须明确，普通歧义使用既有结构化意图及一次边界澄清 |
| 原子切换/恢复 | 消息入口在原全局/会话锁、修订事务内结算旧活跃预算、归档、撤销旧token及待确认、切换当前指针。恢复读取原快照/预算，重新检查权限和来源，暂停并要求既有计划核对。模型new边界提议本身不分配额度；礼貌继续及多分句仍不能重开失败任务预算 |
| 回执及队列 | task-id过滤接入自动续接、控制恢复、背景读取回执和预算证据。旧revision事件/worker写入被围栏阻止；历史结果读取仅返回有权限证据，不能改当前run/核对状态或推进新任务 |
| 当前依赖与历史权限 | 当前依赖由SQL按任务聚合去重；批量检查实际对象和角色。状态、消息页及列表不再把全部历史依赖当当前执行前提。独立B可受理而A历史仍脱敏；当前A继续仍校验A的来源。删除A来源不清空独立B，归档正文按原隐私生命周期清除 |
| 历史与兼容 | 有界游标分页最多50条，用户与自动事件分别计数。新格式移除累计100条turn拒绝；旧关闭任务只读不写task/xmin、不重算消耗。快照独立按需读，不把所有历史任务嵌入当前JSON/每次响应 |
| 统一模型投影 | 当前持久事实包含完整有效合同、待修改请求及必要业务快照；旧失败方案/已撤销原目标不恢复为有效要求。近期自然语言保留为有界、权限过滤的指代证据；当前页面快照优先本轮真实focus，不沿用旧页面标记 |
| 最终出站容量 | 正常、增量、SDK纠错及恢复共用provider最终HTTP包装，核算system、Schema、事实、历史、工具证据和输出预留。先减少可重读正文/较旧历史；最后两条指代证据、当前合同/请求及Schema保持。仍超限返回assistant_context_capacity并保留输入，不发出错误请求 |
| 引用与派生参数 | 真引用字段走原别名与领域校验，Metadata/customerId及ID形状普通值保留；未知引用拒绝。requirements不无界复制为instructions；缺省派生超过8000字符准确阻止，显式有界执行指令沿原冻结要求通路；不截断有效要求、不新开模型摘要链 |

新增一张任务检查点表、可空turn.task_id及必要索引，保留原PostgreSQL/MinIO/AI SDK/Worker；新增有权限检查的只读历史任务GET入口。存储选择、事务、清理、旧格式及回滚见[ADR补充](../../docs/adr/0014-project-agent-and-processing-runtime.md#2026-10-23-opt-48-会话内任务身份与上下文补充)。无新增依赖、任务平台、向量库或前端视觉改动；frontend-v1合同不变。

配置ASSISTANT_CONTEXT_WINDOW_TOKENS默认131072，校验8192～2097152；这是管理员输入加输出容量策略，须不高于提供方实际窗口，不是自动探测模型规格。UTF-8字节上界加实际输出预留及1024封装余量为保守估算，不称为精确token计数。追加额度和多段账本由OPT-49负责，本票不提供。

## 定向覆盖

| 标准 | 最终可观察证据 |
| --- | --- |
| R48-1～3 | A终结→独立B→恢复A保持原身份/要求/消耗；失败130步后继续、改名、3+2、礼貌与多分句不重置；运行中切换阻断旧token和自动事件，旧确认409、不发布；一次歧义回复沿原目标或明确换目标 |
| R48-4 | 一次SQL合成120条混合turn、三个任务及两份独立归档消耗；17条分页无重复/遗漏，用户61/自动60，实际新消息受理到122条；归档预算逐值不变；未发送120次模型请求 |
| R48-5、9 | 捕获真实本地provider出站JSON，撤销的旧目标不当当前规则，全体要求/待修改5条/Schema/输出预留保留；近期解释可供“第二种”普通追问指代；当前页面真实引用优先 |
| R48-6 | 配置8192窗口，必要整包放不下时实际HTTP请求数0，报告具体容量码，输入仍保留；沿原背景范围和跨用户/项目权限，不新增伪造背景理解 |
| R48-7 | 旧关闭格式三种只读视图task JSON与xmin均不变；并发同修订切换仅一个202另一个409；归档原子且无读取迁移；幂等消息重放不重复效果 |
| R48-8、10 | 旧来源失效时原请求409、独立新请求按当前权限受理，页面/模型旧正文不可见；管理员降为查看者后旧写历史脱敏，独立可读目标可用；真实草稿删除触发器保留B任务与预算、清理A正文；否定、引述、普通同义澄清不授新额度 |
| R48-11 | 9项各1000字符及20项各1000字符，在实际正常/SDK截断纠错/503失败后普通恢复的出站整包中逐项完整存在；公开消息执行入口对缺省派生指令准确返回8000容量错误，未创建运行，要求不丢。共享绑定及最近交流裁剪另有单元反例 |
| R48-12 | 实际草稿别名→read_records保留Metadata customerId/runId形状普通值；未知别名拒绝；历史只读快照不切当前任务，来源/权限/旧确认围栏沿真实持久化入口检查 |

| 测试组 | 不同用例 |
| --- | --- |
| 八个单元文件：上下文、任务窗口、规划/准备、执行、回执、预算与恢复决策 | 87 |
| 新assistant-task-context公共HTTP/真实SQL/本地可控模型 | 22 |
| 受影响既有assistant-recovery及assistant-processing-preflight | 51 |
| 合计（去重） | 160 |

[固定配置](opt48-development-20261023/focused-vitest.config.ts)明确收集范围；[运行器](opt48-development-20261023/run-check.py)先校验现有evalbase-agent-test两个依赖容器的Compose归属。夹具创建UUID隔离数据库并只清理自建库，桶为opt48-contract-regressions-20261023；不向Owner验收库执行变更，凭据只在进程环境传递。

复现新合同（在服务器上述工作目录，使用既有隔离服务）：

```bash
python3 .scratch/assistant-optimization/opt48-development-20261023/run-check.py replay.log node node_modules/vitest/vitest.mjs run --config .scratch/assistant-optimization/opt48-development-20261023/focused-vitest.config.ts tests/unit/assistant-task-context.test.ts tests/integration/assistant-task-context.test.ts
```

实际完整集合与每例采用的报告文件由机器清单记录；unit-reviewed/unit-exact、api-confirmed/long-exact和affected-confirmed覆盖不同阶段的最终有效结果。原始过程日志留在服务器同目录，不用重跑历史验收补证。

静态门槛：最终tsc --noEmit、受影响文件ESLint、Prettier、git diff --check通过。文档收尾一次npm run docs:check已通过；改动Markdown链接/围栏及机器JSON另行校验。无Mermaid或主业务流程图变更。

## 过程失败、Standards与Spec

- 初始开发的身份/并发/兼容及部分夹具失败保留在integration-first/second、integration-expanded和intent-recovery日志。修复真实分支和初始化/脚本问题后采用上表最终结果，不累加重复运行。
- 一次最终Standards审阅：0项可操作发现。
- 一次最终Spec审阅：2项P1及1项P2。礼貌继续可绕过边界、全部近期自然语言被移除、长要求恢复/执行容量覆盖不足均已修复，公开入口及实际载荷复验通过。此后仅检查修改和受影响入口，没有重复全量审阅。
- 补充回归首次出现3项夹具/断言错误：历史答复1误匹配115、模拟模型未实际返回选项说明、在持久任务字段而非本轮页面快照寻找pageObject。修正真实模型脚本和断言后20项通过；精确1000字符的六项及公开派生容量两项采用其后结果，新增用例总数仍为22。
- 相邻assistant-execution-plan单元原先把已完成3步误期待为1步，在固定旧plan源码同样失败；更新为真实3步回执，并核对前两步保持executed，未更改业务settle算法。

### 额外旧夹具限制（未伪记通过）

选跑project-assistant.test.ts中的8项为0通过/8失败：7项使用未发出plan_task.control的旧模型夹具（含草稿未建立的连带失败），首项在冻结基线应用上独立复现；另1项仍要求降权后整会话404，和本票“历史脱敏、独立新目标可用”合同不符。没有证明所有旧失败均为本票之前的故障，也没有宣称全仓测试通过。

其当前合同已由新公开用例覆盖：固定确认/幂等、旧确认不能跨任务、来源删除/降权脱敏、当前页面引用与旧关闭格式。原8项结果及baseline-project-compat反证留在同目录；修订整个历史大夹具未作为本票已完成项，后续全仓门禁前仍需适配。

## 保留与边界

- 真实模型请求0、Computer Use运行0；未部署4217，未重跑已完成CU或248/400条。
- 原未提交semantic-results.json SHA-256仍为c99545cc5a5af148cbc194935cf8973fff6260829435b9f717903f1db2f52a0c，未修改或纳入提交。
- 旧预算、源记录、固定ID/hash/seed、采用发布确认边界保持；新增合成历史及额度只存在隔离测试库。未重置关闭的验收预算。
- 本票不保证任意模型/自然语言零失败；真实歧义仍可澄清，必要合同超窗口仍准确停止。OPT-49承担复杂任务账本/续接，OPT-50承担页面及既定有限CU收口，内容质量沿人工审核。
