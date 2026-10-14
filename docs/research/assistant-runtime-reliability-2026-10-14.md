# 项目助手稳定性：开源机制对照与当前代码审查

日期：2026-10-14。状态：调研与整改建议，未实施，不替代现行 PRD、ADR 或 Ticket。

## 1. 结论

建议先完善现有助手的运行机制，再推进独立工作台。保留 Fastify、AI SDK、PostgreSQL、MinIO 和 Worker；当前证据不足以支持迁移到另一套智能体框架。

当前实现已有持久任务、执行租约、业务回执、固定步骤推进、字段保护和处理批次恢复。主要薄弱点是：**模型要维护过多相互关联的业务参数；计划更新对文字表达过于敏感；对话层的模型故障分类与恢复不足；长期上下文及真实任务评估尚未形成统一的发布依据。**

无法承诺任意模型永不出错。可验收的目标是：正常任务稳定完成；暂时故障有界恢复；失败保留成果；不重复写入；状态与实际结果一致；用户能从失败位置继续，不需要补写内部参数提示词。

## 2. 审查范围与证据边界

- 服务器工作树：`/home/bistu/EvalBase/.worktrees/agent-data-processing`，分支 `codex/assistant-optimization`，HEAD `f261a79437247349fd8f3e25b49819229ee5741e`。核对了关键源文件与本地镜像的 SHA-256。
- 阅读当前助手、模型适配、处理恢复代码，相关 PRD、架构、ADR 与现有测试。对照 [当前架构](../architecture/data-selection-and-assistant.md)、[PRD](../PRD-data-selection-and-assistant.md)、[运行时 ADR](../adr/0014-project-agent-and-processing-runtime.md)。
- 从 4217 Web 配置确认应用数据库 `agent_owner` 及所属 PostgreSQL 网络；SQL 使用只读事务、5 秒查询超时。未执行模型请求，未改用户会话、候选、草稿或服务。
- 读取到 14 个历史会话、107 个回合、82 个处理运行、784 个批次。助手回合最新记录为 2026-10-08 UTC；因此这些历史错误**不能用作当前 HEAD 的失败率，也不能证明历史缺陷仍未修复**。
- 另外执行了无数据库、无模型调用的计划函数探针，覆盖实际要求规范化函数后再更新计划。此证据证明函数行为，不冒充当前用户会话的端到端复现。
- 开源部分为固定源码快照审查，未运行或部署第三方项目。建议是结合源码与本项目约束形成的工程判断。

现有验收数据保留。前一份 [工作台设计研究](assistant-workspace-design-2026-10-14.md) 仍是界面提案，本报告补充执行可靠性的优先级。

## 3. 当前实现已经具备什么

| 能力 | 实现位置 | 本轮判断 |
| --- | --- | --- |
| 会话与任务持久化、执行租约、重领 | `src/assistant/tasks.ts:17、245` | 已有；不能将卡住概括为“没有状态管理” |
| 执行前记录意图、固定操作键、未知写入核对 | `src/assistant/agent.ts:727` 及领域提交接口 | 已有；应保留并补具体故障窗口测试，不能直接整段重放 |
| 已知步骤由服务端继续执行 | `src/assistant/agent.ts:2870、3349`，`src/assistant/plan.ts` | 已有确定性执行路径；需要减少重新依赖模型拼参数的边界 |
| 参数校验和一次原生工具协议纠正 | `src/assistant/agent.ts:186、3389` | 已有；不能称为完全没有工具校验 |
| 无进展检测及步数、时间限制 | `src/assistant/agent.ts:332、462、3237` | 已有；需要区分等待、有效进展与不同层的失败 |
| 处理批次错误分类、保留有效结果、有界恢复 | `src/processing/execute.ts:393、569`，`src/processing/recovery.ts` | 已有；对话层和 Worker 的恢复能力并不相同 |
| 数量、配额、字段保护、采用确认 | `src/assistant/requirements.ts`、`review.ts`、`store.ts` | 已有；校验不应取消，问题应优先在参数生成前解决 |

## 4. 当前代码的具体薄弱点

### 4.1 工具接口让模型承担了过多状态协调工作

**已核实事实：** `agent.ts` 定义 14 个业务工具，普通模型步骤通常能看到整套工具。`prepareStep` 主要在最后汇总、后台读取和规划检查点收窄工具范围。

其中 `plan_task` 同时管理要求列表、目标数量、修改字段、分类依据、类别配额、来源、执行步骤、下一动作和澄清问题；步骤内又携带后续业务工具参数。模型需要让这些字段彼此一致。服务端确实会再次校验，但接口容易让模型先生成互相矛盾的表达，再花回合修复。

证据：`src/assistant/agent.ts:1164、1408、1510、3163、3245`。注意 `allowedLabels` 只是兼容旧意图，已从发给模型的 schema 删除，不能将它计作当前模型的新字段。

**历史旁证：** 保留的工具失败中，`plan_task` 参数不合法出现 16 次、数量冲突 4 次；提交处理范围不合法 6 次，局部候选选择不合法 6 次。它们是失败工具调用次数，可能在同一回合被修复，不是独立任务失败率。

**建议：**

- 按查询、规划、执行、核对、待确认阶段提供必要工具，并保留合法补读与修正通道；不要只按关键词猜阶段。
- 模型输出用户意图及当前步骤必需参数。已固定的来源、记录集合、修订、操作身份和完成数量由服务端绑定。
- 用一个规范化的任务约束结构生成摘要和处理参数，减少模型重复填写同一事实。仅改变明确受影响的要求；权限和实际执行仍由服务端判定。
- 复用现有固定步骤执行器。模型负责语义选择，读结果、查数量、接续已确认步骤等确定性动作尽量直接执行。

这不是把所有任务写死为同一流程，也不是新增一个通用 DAG 引擎。

### 4.2 要求清单的顺序变化会使完成状态失效

**已复现的函数行为：** `planRequirementsKey()` 对完整 `requirements` 数组计算摘要；`revisePlan()` 用该摘要决定能否继承已执行步骤。

沿实际 `reviseRequirements()` → `planRequirementsKey()` → `revisePlan()` 路径，用合成只读步骤验证：

| 更新 | 已完成读取步骤的结果 |
| --- | --- |
| 两条要求原样提交 | 保持 `executed` |
| 仅增加尾部空格 | 入口会清理，保持 `executed` |
| 相同两条独立要求只调换顺序 | 变成 `pending`，创建新步骤身份 |

证据：`src/assistant/requirements.ts:246`、`src/assistant/plan.ts:54、95、128`。最初只调用计划函数的空格探针遗漏了入口清理，本报告采用补齐规范化后的结果。

用户要求本身没变，模型重排清单也可能增加重复读取和恢复成本。代码另有已提交副作用回执的保留分支，因此不能由此声称它会重复发布或丢失成果。

**建议：** 区分用于展示的文字与影响执行的约束；无序要求按规范化身份比较，显式有顺序的处理步骤继续保序。仅使受实际约束变化影响的未完成步骤重新核对。不能全局忽略自由文本变化，更不能放松已执行写入的参数保护。

### 4.3 对话层遇到暂时模型故障，恢复不够细

**已核实事实：**

- `ToolLoopAgent` 设置 `maxRetries: 0`；共享 80 秒模型等待信号。
- 外层仅对文本工具模板或 `ToolChoiceViolationError` 做一次协议纠正，其他异常直接进入终结路径。
- 没有可用工具失败回执时，多种非领域异常归为 `assistant_model_failed`。
- 对话诊断主要是 `finishReason/modelSteps/toolCalls/durationMs`，不足以区分 429、5xx、网络断开、输出截断、provider 不兼容或应用内部异常。
- 处理 Worker 已有 `temporary_service/timeout/provider_rejected/invalid_json/...` 等分类，说明可在当前工程内复用分类思路，没必要换平台。

证据：`src/assistant/agent.ts:454、3318、3389、3423、3551`；`src/model/connection.ts:204`；`src/processing/recovery.ts:1`。

**建议：** 在模型请求边界保存脱敏的错误类别、HTTP 状态、finish reason、模型/工具契约版本与耗时；不得记录密钥、完整敏感正文。暂时性请求失败按总预算有限退避；不重试整段业务工作流。

| 错误 | 恢复方式 |
| --- | --- |
| 429、5xx、暂时网络故障 | 在剩余总预算内有限重试模型请求，尊重 Retry-After |
| 参数或输出结构不合法，尚未执行 | 返回字段级反馈，允许一次或少量有界纠正 |
| 已提交操作但响应丢失 | 先用原操作键查询回执，再决定接续 |
| 权限不足、来源删除、草稿冲突 | 停止相关写入，明确用户可采取的操作 |
| 合法结果不足、重复、截断 | 保留有效候选，只处理缺口，继承已有批次预算 |
| 无进展或预算耗尽 | 保存检查点与成果，明确暂停位置和恢复条件 |

超时不等于未执行；参数修复也不能擅自换来源、扩大范围或绕过确认。

### 4.4 长会话的保留方式较粗，背景引用也增加模型负担

**已核实事实：** 模型历史取最近 6 个回合；每个历史回合的工具内容预算 6000 字节，超出的整条工具记录跳过，用户/助手文本分别截断。当前任务快照独立持久化且历史工具调用与结果成对构建，这两点是正确基础。

背景分类则要求模型复制类别名称和短定义，再通过文本与章节边界规则验证。它能拦住错误引用，但也要求模型重复生成很长的、彼此一致的字符串集合。

证据：`src/assistant/context.ts:188`；`src/assistant/agent.ts:2974`；`src/assistant/background.ts:347`。

**风险判断，未在本轮真实模型复现：** 长会话中的“刚才那几条”、已否定方案、未进入结构化要求的纠正可能淡出上下文；长类别清单可能消耗输出预算。不能据此认定当前所有失败都由截断导致。

**建议：**

- 当前对象、有效要求、来源选择、已完成成果、待解决问题保持结构化持久化；模型历史是参考。
- 工具返回简短结果摘要和可再次读取的引用，保留必要调用配对。先改确定性摘要，再由实测决定是否需要模型压缩。
- 对已核对的文档类别提供稳定引用，后续按引用绑定原文和版本；减少重复抄写定义。不能借引用省略首次语义核对。
- 暂不引入向量库或跨会话记忆平台。

### 4.5 测试与诊断还不能证明当前版本的真实任务完成率

项目已有较多真实数据库、HTTP 假模型故障注入测试；也有 `opt06-real-probe.ts`、`opt07-real-probe.ts`、`opt08-real-matrix.ts` 等真实模型脚本。不能说“从未测过真实模型”。

缺口是将这些证据收敛为**固定案例、固定模型及契约版本、重复运行、按用户最终目标计分**的常规基线。本次没有得到当前 HEAD 下重复执行同一任务的稳定完成率。

4217 历史 784 个批次的 `diagnostics` 均为空；这些是旧 recipe/旧执行期的记录，不能用来断言新 Worker 没实现诊断，也不能倒推历史每次失败是模型截断还是网络错误。历史助手失败也多于单纯 provider 故障类型。

**建议：** 复用现有测试设施，统一少量短提示词案例与输出摘要。首轮优先给任务级 trace 补齐版本、失败层、恢复次数、停留阶段及有效成果数量；无需先部署新的可观测平台。

## 5. 开源项目具体值得借鉴什么

| 项目与固定快照 | 已核实机制 | 对 EvalBase 的适用方式 |
| --- | --- | --- |
| DeepSeek Harness `d743267` | 工具参数与成功值 schema 校验；请求分类重试；中断工具区分未启动与结果未知；上下文压缩保护调用/结果配对 | 借鉴错误分层与协议边界；继续使用现有数据库事务和回执 |
| OpenAI Codex `7eed30a` | HTTP 重试与流恢复分层；rollout 历史恢复；工具消息归一化；Goals 扩展有独立预算与空回合控制 | 对话协议、执行事实、传输恢复分别负责；不能把“对话恢复”当成外部业务事务重放 |
| OpenHands Software Agent SDK `6e7a853` | 类型化参数校验；事件先存后通知；重复动作/错误/交替循环检测；有界 critic 修正 | 完善无进展检测，保留有效成果并有界纠正；用业务断言判断数量与保存结果 |

直接源码：

- DeepSeek：[工具定义校验](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/tools/src/schema.ts#L461)、[请求重试](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm-retry/src/index.ts#L149)、[未知工具结果恢复](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session/src/repair.ts#L14)、[配对安全切点](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/compaction/compaction/src/tool-pairing.ts#L104)。
- Codex：[HTTP 重试](https://github.com/openai/codex/blob/7eed30ad1beaebc20b7d848ce9ee887525a379b0/codex-rs/codex-client/src/retry.rs#L22)、[流重试](https://github.com/openai/codex/blob/7eed30ad1beaebc20b7d848ce9ee887525a379b0/codex-rs/core/src/responses_retry.rs#L55)、[历史重建](https://github.com/openai/codex/blob/7eed30ad1beaebc20b7d848ce9ee887525a379b0/codex-rs/core/src/session/rollout_reconstruction.rs#L60)、[消息配对修复](https://github.com/openai/codex/blob/7eed30ad1beaebc20b7d848ce9ee887525a379b0/codex-rs/core/src/context_manager/normalize.rs#L21)。
- OpenHands SDK：[参数处理](https://github.com/OpenHands/software-agent-sdk/blob/6e7a8532ef4426da08b5c06dd57cf4795303be01/openhands-sdk/openhands/sdk/agent/agent.py#L1342)、[先存事件后回调](https://github.com/OpenHands/software-agent-sdk/blob/6e7a8532ef4426da08b5c06dd57cf4795303be01/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L425)、[StuckDetector](https://github.com/OpenHands/software-agent-sdk/blob/6e7a8532ef4426da08b5c06dd57cf4795303be01/openhands-sdk/openhands/sdk/conversation/stuck_detector.py#L104)、[可选 critic](https://github.com/OpenHands/software-agent-sdk/blob/6e7a8532ef4426da08b5c06dd57cf4795303be01/openhands-sdk/openhands/sdk/agent/critic_mixin.py#L25)。

**借鉴边界：** DeepSeek 的重复调用提醒不等于硬终止，其循环文档也明确没有内建 turn budget；Codex 补合成 aborted 只是协议修复，不证明外部动作没有发生；OpenHands critic 可失败返回 None，不能作为采用或发布的硬门槛。三者都不能替代本项目的权限、容量、幂等、来源与语义验收。

相关边界证据：[DeepSeek loop 限制](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/README.md#known-limitations-and-deferred-work)、[Codex Goals 记账](https://github.com/openai/codex/blob/7eed30ad1beaebc20b7d848ce9ee887525a379b0/codex-rs/ext/goal/src/accounting.rs#L229)。

## 6. 推荐架构与整改顺序

整体链路保留：用户目标 → 模型理解/必要语义规划 → 服务端规范化及前置核对 → 持久步骤执行 → Worker 处理 → 服务端核对完整成果 → 用户确认采用/发布。

模型提出动作；服务端绑定对象、判断是否允许执行、推进状态并保存回执。模型可解释真实结果，但一句“已完成”不能改变业务状态。现有模块按这条职责边界逐项收敛，不同时重写整套系统。

### 第一批：先让失败可解释、可恢复

1. 给对话模型请求补分类诊断和预算内传输重试，复用 Worker 已有分类经验。
2. 修正要求顺序导致不必要步骤失效的问题，新增规范化路径回归。
3. 把已有真实模型脚本整理为小型固定基线，先跑出当前版本成绩，再评价后续优化。

### 第二批：降低模型使用工具的难度

1. 按当前状态收窄工具集合，保留合法查询和纠错能力。
2. 收敛 `plan_task` 的重复表达；服务端绑定既有来源、固定选择、约束、成果和操作身份。
3. 背景定义用稳定引用复用；补上下文遗漏后的恢复案例。

### 第三批：再完善工作台

独立页面呈现当前目标、进度、有效成果、需要用户处理的问题和恢复入口。页面应消费已经统一的服务端状态，避免 UI 再维护一套任务完成判断。

暂不引入多智能体、通用可视化工作流、另一套任务数据库或框架迁移。若后续测量证明现有单执行器无法承载跨服务长时挂起等明确需求，再评估持久工作流引擎；它仍不能代替领域事务回执。

## 7. 如何区分模型问题与工程问题

采用同一组小样本、同一目标和同一模型配置，分三层验证：

| 层 | 测什么 | 如何解释失败 |
| --- | --- | --- |
| 模型协议 | 少量只读任务、工具参数、结构化记录输出；不修改 Owner 数据 | 原生 tool call/JSON 都不稳定，先查模型服务协议、schema 兼容和输出预算 |
| 工程执行 | 用可控模型输出驱动真实数据库、回执和任务恢复，注入暂时错误及响应丢失 | 固定合法输出仍执行失败，属于应用状态/执行问题 |
| 用户流程 | 同会话短提示词完成提取、清洗、改写、扩写及中途纠正 | 前两层正常而流程不稳定，重点查工具设计、上下文和模型语义规划 |

若要比较模型，只在最后保持业务流程与工具契约一致做受控对照；不能同时换模型、提示词和工作流后归因。当前仅确认配置模型名为 `qwen3.8-27b-un` 且连接测试成功，连接成功不证明复杂工具调用稳定。本次未新增实际模型能力测试。

建议复用 10 类验收案例：资料定位、固定抽取、规则清洗、字段受限改写、指定数量扩写、按文档分类、执行前修改方案、任务中撤销一项要求、部分失败后接续、重复确认/回执丢失。正常用例用短提示词；有歧义案例应正确澄清，不能计作失败，也不能乱猜对象来提高完成率。

每次记录：目标是否达成、首轮成功、恢复后成功、用户补充次数、失败层、总时长、模型请求数、实际有效数量，以及模型/应用/工具契约版本。数量和字段保护用代码断言；内容质量按任务标准人工抽查，模型评审只能辅助。

先串行运行小样本；200 条只在小样本稳定后作为代表性闭环，不默认扩大并发或长时间压测。可将明确正常案例“连续多次、少提示词完成”设为发布门槛，但本报告不预填成功率或 Owner 验收结果。

以上评估方向也符合 OpenAI 官方的 [基于轨迹与评估改进 agent](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop) 和 [按验证结果有限修复](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex) 的思路；本项目无需引入示例中的全部框架或自动优化设施。

## 8. 本轮产物与限制

本轮仅新增本研究文档。业务代码、模型配置、验收数据和服务未修改；未发起新的处理任务或运行完整模型评估。

本地证据位于执行机 `.scratch/assistant-optimization/`：`runtime-research-owner-evidence.jsonl`、`runtime-research-db-identity.jsonl`、`runtime-research-code-identity.log`、`runtime-research-plan-normalized-probe.json`、`runtime-research-eval-scope.log`；外部源码笔记为 `assistant-runtime-source-notes.md`。报告仅记录必要统计与错误类别，不复制用户正文或凭据。

**下一步建议：先把第一批和第二批整理为边界明确的整改 Ticket，沿现有技术栈实施；工作台设计使用同一套真实任务状态。**
