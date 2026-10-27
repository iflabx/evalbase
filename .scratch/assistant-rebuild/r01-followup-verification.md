# REBUILD-01 后续：受控模型与共享处理回归修复

- 日期：2026-10-27；基线：5f74b2abbb964c73c20d1b537f1a34232497713f；分支：codex/assistant-rebuild。
- 实现提交：e1a9f49fb6c25ebef84327ce3a61c5f4d1fa8372。
- Owner 授权：修复模拟服务6项超时及共享处理2项失败，补回归和定向验证；旧助手6项补后续票据AC；允许必要结构调整，保留旧验收数据和预算。
- 结论：原8项在最终受影响9文件的126项测试中通过，无失败/跳过/未处理异常；旧助手6项未修、未重跑，不标通过。不将此结果扩展为全库或真实模型质量验收。
- 原始历史：[REBUILD-01 实施记录](r01-verification.md)。原14项失败的日志和基线结论保留，本记录只补后续状态。

## 根因与修复

| 原失败/隐藏问题 | 确认根因 | 修复与回归 |
| --- | --- | --- |
| processing-task-rounds 的6项超时 | Worker 后续发出 contract/documents/questionContext/candidates 审核请求；旧模拟服务只认识转换请求的 records，undefined.map 后 HTTP 不响应 | 分流审核/转换；审核返回真实候选身份和逐项 uncertain 证据，不消耗转换脚本/计数；解析失败或不支持的请求立即422；补非法请求HTTP回归及实际审核请求断言 |
| 连续处理的来源链测试 | 模拟每次扩充都生成同名“新问题0”等，第二轮与输入相撞；真实去重正确拒绝，diagnostics 为 duplicate_content/processing_output_incomplete | 模拟按扩充轮次生成不同问题，补跨轮不重复断言；保留来源、字段保护、清洗、重跑、并发保存/重复采用及来源权限断言，不改去重规则 |
| complete补齐接口500 | 没有分类要求的背景仍被加入 classifications:undefined，严格 canonicalJson 拒绝非JSON值 | 存在分类规则才调整配额；缺省保持缺省，不伪造空数组；覆盖201、冻结输入无该属性、同键重放200/同一run/同一hash/唯一子轮次 |
| 500解除后原测试后段恢复21条仅得20条 | 旧冻结recipe v7不执行审核，却仅凭背景标记预留最后一次审核调用，补缺提前结束 | 共用 contentReviewEnabled 决定预留和实际审核；不改maxAttempts或清零计量；验证原3次上限内21条唯一记录、旧版不执行审核、已成功后批次原样保留 |

6个超时场景分别是缺项改写、基础设施/租约失败恢复、前轮候选缺项、重复反馈/时限、扩充追加、仅本轮缺额计数。不是6种真实模型超时，而是同一模拟服务异常造成的挂起。

旧recipe兼容修复保留新recipe原有审核预留。Worker仍用现有SDK；未新增模型、表、依赖、队列或公开API。模拟审核只返回uncertain，验证协议和状态，不声称语义质量合格。

## 首错与验证

测试通过既有隔离服务连接，按现有机制为各集成文件创建唯一数据库及合成对象，不运行旧验收项目任务。外部模型请求0、真实生成0、Computer Use 0；模型请求只发到本地受控HTTP服务。

原始输出保留在服务器工作树 .scratch/assistant-rebuild/r01-followup-verification/，不覆盖原 r01-verification/；原始日志及诊断脚本不纳入产品提交。

1. 原 domain-regressions.log 保留6次 undefined.map/30秒超时；fixture-probe.log 确认实际请求为审核协议。
2. fixture-green.log：轮次文件完整17通过；没有延长超时。审核分流不消耗转换故障脚本。
3. shared-probe.log：来源链记录重复内容拒绝，补齐记录 canonical JSON TypeError。shared-regression-red.log 保留接口500，也有一次模拟文字更新后期望值未同步的测试准备错误，后者已纠正，不冒充产品缺陷。
4. shared-green.log：500解除后首次到达后段，暴露21→20缺口；remaining-recovery-probe.log 显示旧recipe只用2次就为不会执行的审核预留而停止。
5. shared-green2.log：修复共同审核判断后2项处理测试通过、23项按筛选跳过；不把它误报为全文件通过。
6. directed-final.log/.exit：最终完整9文件组126通过，退出码0，无未处理异常。临时 DEBUG-R01R 探针已从最终src/tests清理。

最终执行使用 python3 .scratch/assistant-rebuild/r01-followup-verification/run-directed.py directed-final，后接下表九个文件路径；封装只提供已有隔离连接，执行安装的Node 24、Vitest、真实SDK、业务HTTP、数据库、对象存储和Worker。

| 测试文件（tests/ 下） | 通过数 |
| --- | --- |
| integration/processing-runs.test.ts | 25 |
| integration/processing-task-rounds.test.ts | 17 |
| integration/assistant-rebuild-validation.test.ts | 28 |
| integration/rebuild-business-boundary.test.ts | 6 |
| unit/rebuild-business-imports.test.ts | 1 |
| unit/processing-content-review.test.ts | 23 |
| unit/processing-review.test.ts | 14 |
| unit/processing-protocol.test.ts | 8 |
| unit/processing-deduplication.test.ts | 4 |
| 合计 | 126 |

总时长89.40秒；前轮测试与本组重叠，不相加为独立覆盖数。node node_modules/typescript/bin/tsc --noEmit、针对本轮4个TS文件的ESLint、Prettier及git diff --check通过，静态输出为 typecheck.log/.exit 和 lint.log/.exit。文档检查在最终记录更新后执行。

不重新运行旧助手预检完整文件或历史CU。测试里的部分批次/尝试故障仅写本次唯一隔离数据库；不重开旧活动、不更改旧预算/关闭时间，不把该隔离故障注入解释为重置旧预算。

## 旧助手6项的验收归属

| 旧失败场景 | 后续AC | 验收要求 |
| --- | --- | --- |
| combined field requirements | [R02-9](issues/02-deepagents-session-and-tool-host.md#验收标准)，实际执行由R07-8承接 | 只变字段要求保留固定来源/范围，不误判无范围，受保护字段不变 |
| failed discovery followed by continue | [R05-7](issues/05-materials-upload-and-input-scope.md#验收标准) | 失败/继续后明确文件名可重新绑定，不循环旧候选，不清预算 |
| explicit new filename overrides live page source | R05-8 | 明确B覆盖页面A上下文；同名才澄清，仍复检权限 |
| reduced scope | [R07-7](issues/07-processing-rounds-and-multiple-deliveries.md#验收标准) | 缩小为1条不沿用全部授权，先不执行期间无作业 |
| only refund | R07-7 | 实际退款范围冻结后才执行，未解决不能借继续提交 |
| exclude refund | R07-7 | 实际排除范围保持，不能悄悄提交原全部 |

R07-8要求将要求/来源层证据接到实际清洗和保存闭环。02/05/07仍为not-started/not-run，依赖不变，不增加真实CU样本/预算。这里只补AC，不将相应旧失败或未来票据记为通过。

## 审阅与关闭

冻结审阅基线5f74b2a后的未提交7文件差异（git diff 5f74b2a），补丁SHA256：f2a29d18e2377ad6423be99d7f941c513441f4782346c08d5ff3e6c62e4b9aba。实现提交包含其中4个TS文件；票据与本记录单独收口，未改变受审业务代码。

- Standards：无可行动发现；已核对缺省JSON、旧/新recipe、既有额度、续跑防重、模拟HTTP异常及断言，未发现上限增加或保护削弱。
- Spec：无发现；原授权、Spec §3.5–6及R01-4/5满足，六场景映射完整。审阅代理仅只读代码，实际测试由主执行者执行并取得上述结果。
- 适用矩阵：冻结输入/不可变历史、既有计量、真实服务完成/局部恢复、回执重放及共同调用者。无权限/Schema迁移/永久删除/部署切换变更。
- Ticket Closure Review P0/P1 cleared at e1a9f49fb6c25ebef84327ce3a61c5f4d1fa8372。仅指本次授权修复，不将旧助手6项或整个重建标为完成。

现有验收数据、旧预算及原日志保留；未更新4217、合并或推送。原实施记录不倒写为原基线全通过。
