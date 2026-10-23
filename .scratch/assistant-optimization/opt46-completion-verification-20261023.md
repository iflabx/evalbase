# OPT-46 补强实施与定向验证（2026-10-23）

Implementation: completed。Validation: targeted-pass。Owner: pending。
本记录对应[更新后的 OPT-46](issues/46-compact-plan-amendment-and-recovery.md)，补充原验证，不改签[历次真实 CU 结果](opt46-cu7-repair-verification.md)。

## 范围与版本

- 服务器工作树：/home/bistu/EvalBase/.worktrees/agent-data-processing；分支 codex/assistant-optimization；开发基线 3b44b0eabec2d45f765f045ed727488144c445c2。实现为本记录所在提交中的 src/tests 差异。
- 本轮仅开发与定向验证；4217 未更新，最近部署仍为 2c74b8e。没有调用真实模型、运行 Computer Use、生成验收数据、合并或推送。
- 测试使用合成 HTTP 模型和 evalbase-agent-test 专用 PostgreSQL/MinIO；每个集成套件创建独立随机测试数据库，结束后清理自己的数据库。未连接 Owner 验收数据库，未重置旧预算、重跑旧 CU 或已完成业务部分。
- 预存 semantic-results.json 不属于本轮，未写入或暂存；原 SHA-256 保持 c99545cc5a5af148cbc194935cf8973fff6260829435b9f717903f1db2f52a0c。

## 实际接线与退出路径

| 调用方 | 共同规则及兼容边界 |
| --- | --- |
| plan_task 正式保存、旧步骤规划 | prepareProposal 执行真实引用解码、当前修订绑定、固定 Schema 和纯准备。plan-preparation 合并授权变化、派生总数、解析背景引用并验证完整目标；旧无交付目标的任务保持原合同，同时执行可证派生容量预检。事务继续复检权限、修订及回执。 |
| SDK 参数纠错、业务纠错、补保存及普通继续 | 使用同一准备结果；SDK 的上下文从当前任务和真实用户变更提取，不按坏 ID 排除真实目标。首次位置错误先解析依据、合并后再完整验证，原坏字段位置不变成用户要求。 |
| 普通 / 截断增量声明 | preparePlanAmendment 共用可信目标与本轮字段投影，更新要求 ID；唯一可信对象可无损补齐，未知显式 ID 保持拒绝，歧义不猜第一项。明确新增保留创建分支；合法旧完整更新仍兼容。 |
| 第二次纠错 | 每轮重建最新候选、字段问题、相关事实及受限 Schema；原用户约束、第一次错误、相同修改身份和共用两次 / 截断一次限额保留。format 纠错不得扩大语义，失败字段路径保留，避免退回整份步骤重放。 |
| 共同要求及保护 | 即使省略 deliveries，已有合同仍经 reviseDeliveryRequirements；显式删除真正应用，未经授权不得扩大 allowedFields / Metadata 键范围。沿用既有 replaceSemantics/canUpdate 规则。 |
| 场景及容量 | 用户明确只用 1/2 场景可保存，未指定保持领域默认 3，仅改条数保持合法原场景；不补虚构场景。完整要求不截断，派生 instructions 超过 8000 时返回具体容量字段问题。 |
| 当前反馈 | 已保存事实、pending 和真实 blocker 分开投影；预算、修订、权限、背景及 repair_limit 优先，不能被 pending 覆盖；旧失败不覆盖新成功回执。 |

新增共享结果为 PreparationResult：成功返回规范化 input / goals / requirements；失败携带 tool、operation、path、keyword、code、message，缺少业务选择时另给 question。此处只含规划规则，OPT-47 将接入处理规则；没有新增通用校验引擎、依赖、表、公开 API、第二份生效计划或另一层预算。没有改动 UI，继续使用 frontend-v1 风格及现有 DTO 反馈。

## 回归与静态结果

最终不同用例共 **177 项通过**，不累加重跑次数：

| 检查 | 结果 |
| --- | --- |
| 9 个当前机制单测文件 | 127 通过，0 失败 |
| 当前 assistant-intent / assistant-recovery 公共流程的定向集合 | 50 通过，0 失败；95 项不在本轮筛选范围 |
| 最后修订绑定及顶层增量复核 | 使用上述已计数用例复核，不另计总数 |
| tsc --noEmit | 退出码 0 |
| 本轮 11 个 TypeScript 文件 ESLint | 退出码 0 |
| 格式、diff 与文档链接/生命周期 | 以最终校验结果为准，记录在本目录验证摘要 |

可复现命令使用[精确文件配置](opt46-completion-20261023/focused-vitest.config.ts)，避免扫描 .scratch 中历次源码快照：

~~~sh
vitest run --config .scratch/assistant-optimization/opt46-completion-20261023/focused-vitest.config.ts tests/unit
vitest run --config .scratch/assistant-optimization/opt46-completion-20261023/focused-vitest.config.ts tests/integration/assistant-intent.test.ts tests/integration/assistant-recovery.test.ts -t 'OPT46|committed|late correction|revok|concurrent|stale revision|double|stopped|background'
tsc --noEmit
~~~

各命令需既有隔离测试服务和相应环境变量，不在文档存放凭据。原始日志留在服务器 opt46-completion-20261023，精简可追溯结果见[验证摘要](opt46-completion-20261023/verification-results.json)。

### 固定失败与修正

- 开发前公共回归复现缺 ID / 冗余总数未同步、明确 1/2 场景仍被拒和 pending 遮盖 blocker 等失败；修复后对应链路通过。
- 共用检查首次误扫描 .scratch 历史源码夹具，包含旧断言与重复用例；相关数字不算本轮通过数。改为显式 include 后，仅当前工作树回归计数。
- Standards / Spec 同轮审阅各发现同一个 P1：无 deliveries 的顶层变更绕过合并保护。5 项公共回归先 0/5、修复后 5/5；两轴定向复核均确认关闭，其余差异无剩余 P0/P1。
- 连续纠错公共回归实际观察两次纠错请求：第一次未知交付引用，下一候选使用可信交付但配额不符；第二次请求包含新候选及新配额问题，最终持久化 3+2=5，未创建处理任务或草稿。
- 同名歧义公共回归发现缺 ID 被当成新建缺字段、消耗纠错而不澄清。共享准备现返回具体业务问题；仅当前修订且固定校验纯缺项可走问题分支，未知字段/类型/旧修订不豁免。direct、SDK容器及完整业务提议三入口均仅问一次、零额外纠错请求；回答第二份后只改第二份、总数5，零业务副作用。
- Spec定向复核发现新增序号绑定会忽略越界序号（P2），已保留全部显式序号，任一越界先澄清；新增回归先失败后通过。否定语句中的“其余全部不变”也不作全选。P1/P2均关闭。
- 容量回归揭示旧普通规划尚未进入新预检，已将正式准备前移到共用规划入口。另一个长要求测试触发现有 context_capacity：完整输入保留，明确判失败，不以口头或保存局部事实宣称整轮成功。
- 初次 Lint 发现一个未使用导入，删除后复查零错误；测试的原始 ID 断言改为实际出站引用投影断言，不改变业务通过条件。

## 验收标准映射

| 标准 | 本轮证据 |
| --- | --- |
| R46-1～6 | 原核对/增量/口头后截断/普通继续/双击及响应丢失/停止撤权/背景变化公共回归，加本次共享接线后受影响边界重查。旧完整更新、首次分类迁移保持可用。 |
| R46-7、11 | 普通与 SDK 容器输入均缺 ID / count，可信目标绑定及 3+2 派生5；实际广告 Schema 要求真实更新 ID，最终持久值和零副作用断言。同名歧义三入口只问一次；普通回答第二份后真实续接，混合有效/越界序号不部分保存；合法新增兼容检查。 |
| R46-8 | 正式保存、SDK 参数准备、业务修复验收共用同一解析/合并/保护；初次期望输出→Metadata 的五种正确/越权变体及顶层省略集合保护回归。 |
| R46-9 | 运行时二次纠错单测与真实 HTTP / SDK / DB 连续故障公共回归共同检查最新问题、候选及两次额外请求。 |
| R46-10 | pending + 六类 blocker 单测，公开恢复、真实回执及原限额检查。 |
| R46-12 | 条件缺项、空白、重复场景及容量一次返回已知字段问题；未知字段/false/未来依赖保持给实际 Schema 判断；共同要求删除、Metadata null/扩张授权保护公共流程。 |
| R46-13 | 明确 1/2 场景实际保存、默认3及仅改数量保持原场景；20×1000要求不截断。派生超容量公共入口返回 path=/requirements、keyword=capacity，无业务副作用。完整大事实的上下文投影限制仍属 OPT-48，未加大上限。 |

## 仍保留的边界

- 本轮是合成模型与实际公共接口的定向验证，不证明真实模型任意输入稳定，也没有替第7项 CU 改签通过。旧失败与旧预算原样保留。
- 合法长要求仍可能触发现有 30000 字节当前事实保护；本票保留完整提议、给出失败并不生成数据。最终全请求容量及可信投影由 OPT-48 实现，不用本轮单测冒充其完成。
- OPT-47～50 保持未开发，原依赖不变。没有代签 OPT-31 质量验收，也没有重跑旧生成部分。
