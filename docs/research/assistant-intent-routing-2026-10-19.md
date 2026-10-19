# 项目助手意图理解与操作控制：开源调研及建议

日期：2026-10-19。状态：研究建议，尚未实施，不改变已批准产品合同或 Ticket 依赖。本轮只读核对源码和官方资料；没有调用项目模型、运行生成、修改验收数据、恢复预算或重跑已完成部分。

## 1. 结论

建议保留现有 AI SDK、持久化任务和 Worker，在现有消息入口统一“本轮要做什么、针对谁、是否允许执行”的决策。明确按钮命令直接校验执行；自然语言由现有主模型结合上下文理解；两者最终使用同一服务端操作守卫。无需每条消息增加独立分类模型，也无需迁移整个 Dify、Rasa、Codex 或 DeepSeek Harness。

这里的意图理解包含两件事：业务目标（查询、选取、清洗、改写、扩写等）和操作方式（解释、只规划、执行、暂停）。“每类改成20条，然后继续”同时包含修改和执行，不能硬塞进单个互斥标签。模型提出操作不等于获得权限、已经执行或内容合格。

这是根据下述源码和本项目合同作出的设计判断，不是某个框架的原样复制方案，也没有经过新的准确率对照实验。

## 2. 开源项目如何处理

| 项目 | 实际做法 | 对本项目的价值与限制 |
| --- | --- | --- |
| Dify / Graphon | Question Classifier 使用 LLM 在配置类别中选择一个分支；If-Else 是变量条件路由；Agent 的工具选择又是另一机制。 | 显式分类适合固定分流；不适合直接作为复杂多操作的执行许可。其分类器不提供置信度。 |
| Rasa Open Source | 用标注样本训练 DIET 等 NLU 组件，预测意图排名和实体，再由对话策略结合 Tracker 选择动作；FallbackClassifier 用分数和前两项差值触发回退。 | 可以借鉴不确定时澄清、语义与对话状态分开；引入整套训练和 Python 服务不符合当前需求。组合意图必须有对应训练组合。 |
| Codex | 交互层有 Plan 等明确模式；协议区分普通输入、回答与中断；输入准入根据当前活动任务决定启动、追加或拒绝。模型通过工具调用选择具体动作。 | 值得借鉴明确命令、模式与运行状态的分工。在本次检查的消息准入和工具路由主路径中，没有看到每轮前强制独立运行的自然语言分类模型。 |
| DeepSeek Harness | commands 扩展直接解析已注册命令；普通模型循环接收消息，生成工具调用，再由工具层检查可用性、限制及钩子。pre-step 是扩展点。 | 命令入口和模型入口可以共用执行约束；扩展点本身不是内置意图分类器，也不替本项目定义草稿、交付和预算规则。 |
| AI SDK | ToolLoopAgent 提供模型工具循环；prepareStep、activeTools、toolChoice 可按状态调整可见工具及选择方式。 | 当前项目已使用这些能力，可以继续复用；SDK 不会自动判断“这句继续授权了哪份成果”，这部分仍需应用定义。 |

主要依据：[Dify 分类文档](https://docs.dify.ai/en/cloud/use-dify/nodes/question-classifier)、[Rasa DIET](https://legacy-docs-oss.rasa.com/docs/rasa/components/#dietclassifier)、[Rasa 多意图限制](https://legacy-docs-oss.rasa.com/docs/rasa/tuning-your-model/#doing-multi-intent-classification)、[Codex 输入准入](https://github.com/openai/codex/blob/1277bcfddc69800c5e3538dccf3f26bedbd80290/codex-rs/core/src/session/turn_input.rs#L64-L88)、[Codex 工具路由](https://github.com/openai/codex/blob/1277bcfddc69800c5e3538dccf3f26bedbd80290/codex-rs/core/src/tools/router.rs#L256-L268)、[Harness 命令入口](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/interaction/commands/src/index.ts#L332-L370)、[Harness 工具循环](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/agent.ts#L529-L555)、[AI SDK 循环控制](https://ai-sdk.dev/docs/agents/loop-control)。

两个重要边界：

- Dify 当前依赖的 Graphon 0.8.0 中，JSON 解析成功但类别字段缺失或类别 ID 无效时，会回退配置的第一类；解析抛出 ValueError 则节点失败。不能照搬这个默认值，把无法判断的输入落到“执行”。见[结果处理源码](https://github.com/langgenius/graphon/blob/4b9590652c63f444c4ba8f9ab5f477290dc58d07/src/graphon/nodes/question_classifier/question_classifier_node.py#L369-L402)。
- 当前 Rasa CALM 支持命令序列，例如同一句设置槽位并启动流程，但属于当前需许可证的产品线；不能把这项能力当作上述 Rasa OSS 仓库已经开放的实现。这里只借鉴组合操作表达，见[官方命令生成文档](https://rasa.com/docs/reference/config/components/llm-command-generators.md)和[许可边界](https://rasa.com/docs/pro/installation/licensing/)。

## 3. 当前 EvalBase 的实际情况

核对位置为服务器 EvalBase 功能工作区，文档基线 HEAD 441d4b2；不是本机另一个 AgentBench_v2 文档项目。依赖文件中为 ai 7.0.127、@ai-sdk/openai-compatible 3.0.62。合同继续以 [PRD §7](../PRD-data-selection-and-assistant.md#7-ai-04-项目助手)、[现有架构](../architecture/data-selection-and-assistant.md)和 [ADR 0014](../adr/0014-project-agent-and-processing-runtime.md) 为准。

已有功能并非完全没有意图判断，但判断分散：

| 现有代码位置 | 已有行为 | 待改善点 |
| --- | --- | --- |
| [agent.ts](../../src/assistant/agent.ts)，requirementsOnly / planningIntent，约 411–423 行 | 正则识别“先不执行”“先给方案”等表达。 | 同义、否定、引用和组合请求容易使规则继续膨胀。 |
| 同文件约 5332–5505 行 | 结合用户消息、旧任务、背景和失败状态决定记录要求、规划恢复、查询或暂停。 | 入口决策与恢复状态交织，难以一次看清当前回合究竟允许哪些动作。 |
| 同文件约 5653–5657、5905–5968 行 | 提示词要求最新意图优先；规划时限制工具，并要求真实保存方案。 | 已有合适基础，但提示词、工具可见性和实际执行守卫应消费同一个决定。 |
| 同文件约 6101–6134 行 | 少数固定执行短句可直接启用已保存方案；其它情况进入模型判断。 | UI 的明确执行动作不应长期依赖中文句子完全匹配。自然语言仍应理解上下文。 |
| [store.ts](../../src/assistant/store.ts) 约 785–867 行及 [tasks.ts](../../src/assistant/tasks.ts) | 新输入推进任务修订并重新核对；自动事件检查暂停、方案模式、修订和额度。 | 必须保留这些并发和授权保护；不要为了简化入口再建第二套任务状态，或把自动回调当成用户同意。 |

上述是源码审查发现的结构性风险；本轮没有复现新的误执行，不把潜在风险报告成已经发生的故障。当前部分不稳定来自参数契约、恢复、内容质量与审核，不能全部归因于缺少意图分类节点。

## 4. 建议流程

用户消息或按钮操作 → 绑定真实会话/任务/选中范围 → 形成当前回合操作决定 → 服务端校验 → 现有规划/工具/Worker → 真实回执与状态反馈。

### 4.1 明确操作直接走结构化入口

“暂停”“继续执行”“确认采用”等已有按钮使用现有控制或确认接口。若某按钮目前只是发送固定中文，可在原请求中增加最小的受限操作标记，绑定当前任务和修订；不新增一组公开 API。该标记来自用户真实操作，不由模型或背景文档制造。具体可执行性仍由服务端检查。

停止后续自动步骤与取消已经运行的处理任务必须分清；“暂停”不能直接显示为模型 Worker 已停止。参考 Codex 的中断协议及 [Rasa 暂停语义](https://legacy-docs-oss.rasa.com/docs/rasa/action-server/events/#pause)，实际 Worker 控制沿用本项目已有接口和回执。

### 4.2 自然语言复用现有主模型

模型读取本条消息、必要的近期上下文、当前任务状态、待回答问题、当前交付及明确选中范围。背景文档用于理解任务内容，不作为用户授权指令。

沿用现有 plan_task、执行模式、要求更新与澄清字段，整理成一个内部决策结果：目标对象、要求变更、操作方式、是否存在实质歧义。只有缺少的控制语义才增补可选字段；不另建意图库、训练服务或持久化计划系统。

- 解释/查询：可直接读与回答，不强迫为普通问题创建计划或写业务要求。
- 只规划：允许必要查询和保存方案，不启动生成或采用。
- 修改后执行：先保存并校验新要求，再推进仍有效、尚未完成的步骤。
- 暂停并修改：先落实暂停，再更新相应要求；不会因“修改完成”重新启动。
- 不确定：只有来源、目标、范围、操作后果存在实质歧义时，问一个用户能回答的问题。工具参数不合法走已有有界纠错，不把内部字段名交给用户修复。

模型不必输出数值置信度，更不能用它自报的 0.9 作为启动写入的凭据。完整性、目标可解析、当前授权和状态转换能否成立，是可以检查的条件。

### 4.3 一个共用执行守卫

把规范化后的本轮决定用于 prepareStep 的工具限制，也用于实际副作用工具、advanceExecution 和自动续步的校验。工具隐藏不能替代服务端拦截；修复参数或换工具不能扩大已确定的操作范围。

沿用权限、taskRevision/执行令牌、来源与字段保护、预算、幂等回执及固定确认。用户要求生成不等于批准采用或发布。解释性提问不改业务要求；真正修改要求才使受影响成果按现有规则重新核对。保留现有任务修订与确认保护，不因“只查询”就跳过旧响应防写守卫。

任务仍是唯一持久化事实来源。若需要诊断，仅在已有回合记录里存紧凑的决定摘要和原因码；不增加表，也不存模型思维过程。明确错误显示用户可操作的说明，内部参数错误留诊断详情。

### 4.4 成本和复杂度

不增加每条消息必跑的独立 LLM。明确按钮无需意图模型调用；规划时可将决定合入已有方案工具调用；部分原来直接发写工具的自然语言回合，采用先决策后写入后可能多一个模型回合，实施时应实测调用数和延迟，不能提前承诺零开销。

不新增框架、服务、数据库表、向量库、训练分类器或多智能体。只做入口统一、复用现有工具结果和共用执行守卫；不能为控制调用数而绕过必要授权或确认。

## 5. 普通中文应如何处理

| 用户输入与上下文 | 期望结果 |
| --- | --- |
| “先给我方案，别生成。” | 查询所需依据并保存方案，零生成任务。 |
| “每类改成20条，先不执行。” | 修改对应配额并保存；不生成、不采用。 |
| “每类改成20条，按新方案继续。” | 更新与核对后执行未完成部分；不能重跑已完成成果或自动补预算。 |
| “为什么失败？” | 读取原因并解释，不自动重试。原已授权后台工作是否仍运行需如实说明。 |
| “不要继续生成，先解释原因。” | 暂停后续推进再解释；运行中任务是否取消由真实控制结果说明。 |
| “先解释方案，再开始执行。” | 保留用户明确给出的顺序；在范围和预算允许时解释后执行，不因出现“解释”就丢掉后半句。 |
| “继续。”，此前仅授权先出方案 | 根据当前待办解释是继续完善还是开始生成；无法确定时只澄清这一处，不默认扩大授权。 |
| “继续。”，已有明确执行授权且停在可恢复步骤 | 核对回执、状态与剩余额度后恢复未完成部分。 |
| “文档里‘立即执行’是什么意思？” | 解释引用文字，不执行。 |
| “这两条改得更自然。”，界面明确选中两条 | 对选中候选提出局部改写，保留其它记录，不扩大到全部成果。 |
| 用户回复“好”，存在待回答的业务问题 | 仅结合明确待回答问题解释；不能一概当作新生成、采用或发布许可。 |
| 规划模式收到后台完成事件 | 对账已发生事实，不获得新的用户授权，不切换到执行。 |

## 6. 实施顺序与验收建议

建议作为一个范围明确的后续改进，按两步实施；本研究不创建新 Ticket，也不改变现有依赖。

1. **先统一现有入口决定和守卫。** 保留兼容行为，明确按钮走结构化控制，集中现有规划/执行/暂停决策；固定纯查询、否定、引用、过期修订、重复事件和预算守卫回归。无需先更换模型。
2. **再补组合请求。** 复用现有要求更新，使修改、解释、执行的顺序与目标一致；使用普通中文和真实任务状态验证，观察额外模型调用与延迟。

建议用上述场景及相反状态组合形成约 20 个固定回归用例。验收要检查实际数据库状态、工具调用和 Worker 创建数，不只检查模型说了什么：

- 只规划、解释、引用、暂停后旧回调不得产生新的未授权业务写入。
- 最新要求实际落库，正确目标收到修改；旧响应不能覆盖新决定。
- 已完成步骤不重跑；未知写入先对账；旧预算和累计值不重置。
- 组合请求顺序正确；实质歧义才澄清；UI 命令与文字等价操作最终受同一守卫约束。
- 模型格式或参数错误只能在既有边界内纠正；纠错失败保留进度，不能回退默认执行。
- 后续在新建隔离会话做一轮普通提示的 Computer Use 检查；不拿已有 400 条成果反复生成，不擅自消耗旧验收预算。本次尚未进行这些新测试。

## 7. 与当前整改的关系

[OPT-39](../../.scratch/assistant-optimization/issues/39-delivery-review-scope-and-continuation.md) 负责交付归属、自动续步和收尾；意图入口应复用它的状态与回执边界，避免两个地方分别推断当前交付和授权。若按顺序开发，可先完成其确定性修复，再收口入口；这不是本研究新增的硬依赖。

[OPT-40](../../.scratch/assistant-optimization/issues/40-generation-boundaries-and-question-dedup.md) 仍负责生成分类边界与问题去重，[OPT-41](../../.scratch/assistant-optimization/issues/41-content-review-evidence-and-budget.md) 仍负责审核证据与预算。[OPT-31](../../.scratch/assistant-optimization/issues/31-rewrite-effectiveness-and-quality.md) 的既有质量验收保持。增加意图识别不会自动修复语义误标、模型漏检或保证永不报错。

## 8. 可复用代码与证据版本

最直接的代码复用是继续使用项目已安装的 AI SDK ToolLoopAgent / prepareStep / activeTools 等 API，以及本项目现有 plan_task、任务修订、控制接口、回执和 Worker；不为这个需求引入新的完整运行时。

Codex 的命令/模式准入和 Harness 的命令入口、工具守卫适合借鉴结构。它们面向编码任务的协议和扩展对象不能原样替代 EvalBase 的业务控制；本次没有识别出一段复制后即可稳定理解本项目所有意图的通用实现。Dify 的单分类回退不照搬；Rasa 的分类训练也不作为当前最小方案。

| 项目 | 固定源码版本及许可事实 |
| --- | --- |
| Codex | 1277bcfddc69800c5e3538dccf3f26bedbd80290；[Apache-2.0 LICENSE](https://github.com/openai/codex/blob/1277bcfddc69800c5e3538dccf3f26bedbd80290/LICENSE)。 |
| DeepSeek Harness | 687f282e8625c6b8d11ff58211a90524be2e4317；[MIT LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)。 |
| AI SDK | 核对主干 d08bb664284fefe1201076626781dfe4e416a9b9 与官方循环文档，项目实际依赖版本见 §3；[Apache-2.0 LICENSE](https://github.com/vercel/ai/blob/d08bb664284fefe1201076626781dfe4e416a9b9/LICENSE)。 |
| Dify / Graphon | Dify 823f40e71fc9e045a9ff2aa903a74b5b001dff33 的 [依赖](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/api/pyproject.toml) 为 graphon 0.8.0；Graphon 固定 4b9590652c63f444c4ba8f9ab5f477290dc58d07。Dify [根许可](https://github.com/langgenius/dify/blob/823f40e71fc9e045a9ff2aa903a74b5b001dff33/LICENSE) 有额外条款；[Graphon](https://github.com/langgenius/graphon/blob/4b9590652c63f444c4ba8f9ab5f477290dc58d07/LICENSE) 为 Apache-2.0。 |
| Rasa OSS | 公开稳定 release 3.6.21；本次源码 c4069568b4fe2adb5d5a1e55d17ce8cb9dda27fc 的版本是 3.7.0a1，不把 alpha 当稳定版；[Apache-2.0 LICENSE](https://github.com/RasaHQ/rasa/blob/c4069568b4fe2adb5d5a1e55d17ce8cb9dda27fc/LICENSE.txt)。当前 CALM 产品另见 §2。 |

本轮只记录机制和设计建议，没有复制外部实现代码。外部源码的“存在此机制”不构成本项目准确率或性能的实测证据。
