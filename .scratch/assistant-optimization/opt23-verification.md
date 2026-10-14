# OPT-23 验证记录

## 范围与版本

- Ticket：[OPT-23](issues/23-assistant-context-and-background-refs.md)，2026-10-14 获 Owner 单张开发授权。沿用 `codex/assistant-optimization` 和同一 4217。
- 实施基线：`56a71001c10fb10e3aec68cb35bee60450caeb16`；固定代码：`ad0b8de9317247e42e5a93c3d110267a3e5a183e`。
- 后续测试兼容提交：`02d334edea1daaaa6e7a8fe315367aeb50a157ef`，仅调整既有分类流程 fixture 的阶段声明；应用源码与固定 Web 完全相同。
- 本张仅完成当前事实、持久选择、工具摘要和附件定义引用；无新依赖、数据表、公开 API、模型摘要调用或前端样式变更。独立助手页面和整任务交付分别留给 OPT-24/25。Implementation completed、Owner pending。

## 实现与边界

每轮从真实 task、合法当前来源和回执重建事实，不依赖近期聊天恰好仍包含对象。当前字段保护、数量、分类和有效要求完整保留；旧原话仍在数据库，模型参考单独限长。超过当前事实容量时明确失败并保留要求，不静默丢弃约束。

固定勾选写入已有 task JSON，省略选择沿用可证范围；候选来源身份按已有有效成果算法核对。不同来源行的较早批次仍可调整，同一来源行被后续独立运行或处理子轮替代时旧勾选失效。不会把不明确指代扩大成全量，也不迁移旧聊天来推测选择。

长工具结果保留成对调用/回执、有界预览、范围统计与重读参数；省略正文不表示全量读取完成。实时步骤使用原可信结果推进，摘要保留历史恢复所需的 offset、partial、missingCount 等完成证据。后台冻结输入、真实参数和权限复检保持原合同。

背景定义首先使用原分类/用户依据校验。已验证定义的会话内引用绑定账号、附件、提取版本、页/行原文及哈希；服务端复原旧完整定义并继续原校验、冻结。注册项仅保存字段、类别和引用，无第二份长期记忆或新摘要链。伪造、错类别、跨账号/会话、附件移除、哈希/提取版本/文本/位置改变均被拒绝。显式撤销全部分类可清理旧依据；省略分类参数仍保留普通附件依据。旧完整 definitions 兼容。

## 定向回归与审阅

| 验收 | 证据 |
| --- | --- |
| R23-1 | 超过八回合仍保存原勾选；五十条无关历史后当前来源、数量、字段保护和有效要求仍在事实中，旧历史不删除。 |
| R23-2 | 大正文成对摘要可重读；真实超过 30KB 的全量读取完成有序步骤；读取/处理的摘要回执仍可推进恢复步骤，部分读取不冒充全量。 |
| R23-3 | 较早甲批次在另一个乙批次完成后仍可只改甲；子轮取代、独立重做乙后旧勾选拒绝，且未创建额外处理运行。 |
| R23-4 | 小型已知答案附件的引用恢复与冻结完整规则、原文、哈希和提取版本一致；伪造/类别/会话/账号/内容版本/位置失效均有检查。 |
| R23-5 | 原用户依据、撤回兜底标签、无 definitions 的用户分类继续通过；删除附件后显式撤销规则可继续，普通附件省略 classifications 不清空证据。 |

- 修复前新单测失败；旧 `56a7100` 的隔离代码快照中三项公开场景分别在持久选择、五十条后来源和引用注册断言失败。只调整旧模型事实前缀以适配 fixture，没有改旧业务逻辑。日志为 `opt23-unit-red.log`、`opt23-public-red.log`。
- 最终受影响单测 29 项通过，1 项依赖外部 PDF 路径的既有检查跳过；实际 PDF 提取/页码和损坏 PDF 检查通过，见 `opt23-unit-final.log`。
- 公开 HTTP 定向覆盖原回执/并发恢复、未知写入、附件容量/个人隔离、会话删除和伪造定义；正常背景冻结/修正规则、长会话/摘要回读及新引用路径通过。保留初次 fixture 和审阅失败日志，不用后续成功覆盖：最终证据见 `opt23-public-final.log`、`opt23-final-guards.log`、`opt23-review-fixes.log`、`opt23-final-targeted.log`、`opt23-background-omission-final.log`。各日志只证明其中实际通过的断言，带失败日志不计为整组通过。
- 根 typecheck、受影响 ESLint、差异检查通过。一次 Standards/Spec 最终审阅发现大结果推进证据、历史原话挤占容量、独立重做后旧勾选和删除后规则撤销问题，均补修并针对直接路径复核；省略分类误撤销的相邻回归也已关闭，无剩余相关 P0/P1。
- 既有授权 `GB-T45654-2025.pdf` 第 13 页/片段 11 的一个真实定义仅做只读引用核查：复用定义保持一致，跨会话及移除引用拒绝；0 Owner 写入、0 模型调用。0600 临时原文自动删除，不入 Git。此检查不表示候选语义或国标合规通过，见 `opt23-gb-reference.log`。

## 固定短请求

统一入口 `scripts/assistant-baseline.ts`，固定合成八条资料；可控模式核对合同，真实模式只读复用加密模型配置并在独立数据库/桶执行，完成后清理。模型为当前配置修订 1 的 `qwen3.8-27b-un`；提示和工具合同 v3。背景文档的真实样本使用两类小型已知答案资料，不做 200 条生成或压力测试。

固定版命令：

```sh
GIT_SHA=ad0b8de9317247e42e5a93c3d110267a3e5a183e python3 .scratch/assistant-optimization/opt23-baseline-runtime.py --mode=controlled --cases=A2,A7,A8 --output=.scratch/assistant-optimization/opt23-controlled-final.json
GIT_SHA=ad0b8de9317247e42e5a93c3d110267a3e5a183e python3 .scratch/assistant-optimization/opt23-baseline-runtime.py --mode=real --cases=A7,A8 --output=.scratch/assistant-optimization/opt23-short-real.json
GIT_SHA=02d334edea1daaaa6e7a8fe315367aeb50a157ef python3 .scratch/assistant-optimization/opt23-baseline-runtime.py --mode=controlled --cases=A8 --output=.scratch/assistant-optimization/opt23-controlled-final.json
```

可控 A2/A7 通过；首次 A8 中既有长分类流程仍直接请求未开放阶段的工具，因此 fixture 失败，重跑前将原报告保留为 [首次报告](opt23-controlled-first.json)。只为恢复选择/越界调整两处操作增加同回合 plan_task 阶段声明，保留原配额、缺额、越界拒绝、字段保护、局部修改和确认断言；定向流程通过，见 `opt23-a8-phase-final.log`。修正后的可控 A8 两个映射用例均通过，见 [定向报告](opt23-controlled-final.json)；其 fixture inputHash 和测试提交另记，不冒充初次通过或改写真实模型结果。

真实小样本只执行一轮 A7/A8，未筛选成功重跑；[原始报告](opt23-short-real.json) 记录如下。

| 情景 | 目标断言 | 用户提示 | 耗时 | 工具参数失败/恢复 |
| --- | --- | --- | --- | --- |
| A7 长会话保持当前资料与要求 | 通过；八条成果、范围和要求保持，没有新增处理运行 | 9 | 54.8 秒（整个九条提示情景） | 0 / 0 |
| A8 按小型附件分类、保护原题和答案 | 通过；八条候选保留原题和答案，新增合法分类 | 1 | 24.6 秒 | 0 / 0 |

两项均停在真实 `awaiting_review`，不是已采用或已发布。模型样本有限，没有同版本修复前真实 A7/A8 对照，不能据此计算通用成功率提升；分类内容仍待人工审核。可控报告的 goalCompleted 为 null，不冒充模型完成率。

## 4217 与验收数据

固定镜像构建通过，限制 1 CPU/2 GB；同一 `evalbase-agent-owner-checkpoint` 的 Web 切到 `evalbase-agent-checkpoint:ad0b8de93172`。服务端 `/health`、`/health/ready` 和本机 4217 转发均确认 `ad0b8de9317247e42e5a93c3d110267a3e5a183e`，PostgreSQL/MinIO 正常。

切换前保存权限 0600 的 `opt23-owner-before-ad0b8de93172.dump`；包含背景附件的 17 张业务表数量及内容指纹全部一致。保留 2 账号、18 资产、17 草稿/1548 条记录、62 任务/82 运行、14 会话/107 回合、11 附件和 8 正式版本。数据库、对象存储及 Worker 容器与挂载未改，两项 Worker 仍为 `4af93adaeda7609e3177fe2013e4091d6320acdc`。

真实浏览器检查处理列表和最新会话均为 200/可见；旧失败可展开、输入保留、0 页面异常，只登录/登出，没有发送助手消息或采用成果。构建、切换和现场证据为 `opt23-fixed-build.log`、`opt23-checkpoint-cutover.log`、`opt23-checkpoint-browser.log`；指纹文件和私有备份仅存服务器、不入 Git。仅更新原验收 Web，不切生产、不合并 main 或推送。

## Owner 简短验收

1. 打开原会话，核对原要求、背景附件和历史成果可查看。
2. 对少量候选勾选两条，发送“只改这两条的 Metadata”，经过多轮查询再发送“继续沿用刚才的勾选”，核对仅操作仍有效的范围。
3. 使用已读的小型分类文档，保存方案后继续简短指令，核对原定义保持；删除附件并撤销分类后应能继续查询。

自动回归中的伪造、撤权、版本篡改和失败注入均在隔离环境完成，人工验收无需破坏真实数据或反复生成大批内容。
