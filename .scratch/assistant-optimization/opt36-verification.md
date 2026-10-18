# OPT-36 确定性执行、回执与恢复：实施验证

日期：2026-10-19。Implementation completed；Owner pending。

## 范围与代码身份

- 分支 codex/assistant-optimization；基线 67a31ce28fc71f4cd139046cedae08d727252b36（OPT-35）。服务器仓库 /home/bistu/EvalBase/.worktrees/agent-data-processing。
- 本记录与源码同次提交；最终提交号见 Git 历史。源码/测试内容摘要 SHA-256：5844ea5a6558ff7bd6a564477203451d53b131a56347b9a157022e78ed370ef1。按下列路径顺序将“路径、NUL、文件SHA-256、换行”拼接后再计算 SHA-256。
- 清单：src/assistant/{agent,plan,fence,store,context,budget,receipts}.ts；tests/unit/assistant-execution-{plan,budget,receipts}.test.ts；tests/integration/project-assistant.test.ts。括号按列出顺序展开。
- 仅本票：没有修改UI、公开API、数据库表、模型生成/语义审核算法或依赖。未更新4217、重启服务器、合并main或推送；OPT-37未实施，OPT-31旧内容验收未代签。

## 实现与边界

- 普通模型工具、明确执行、后台终态、确认和恢复汇入既有 advanceExecution。固定步骤调用同一业务工具、校验、权限和事务 fence；有真实语义或参数缺口才交给 AI SDK，未另建循环或调度器。
- settleExecutionPlan 统一工具回执与领域提交的步骤投影。后台提交仍在原事务中关联真实run；同一操作先查当前/历史原键回执，未知效果不能换键重做。
- 新交付（包含单份）的核对和采用卡片由服务端编译。runId/目标草稿仅从当前 delivery 的真实回执绑定；显式冲突仍在实际效果前被拒。下一份保留自己的原定义、场景与数量，不沿用上一份分类。
- 错误按动作、步骤和修订或同一领域操作键判断恢复；删除全局 repairFailure 优先级。恢复成功不抹去历史错误，另一动作/交付失败及未保存要求仍阻止完成。
- 新交付的全部固定步骤和真实完整确认均成立才完成；部分采用不能充当整体完成。旧任务沿原阶段行为；读取页面的历史发布完成判定也检查剩余步骤、暂停及待核对状态。
- 累计预算复用现有JSON检查点，具体上限集中见 [架构§16](../../docs/architecture/data-selection-and-assistant.md#16-opt-3437-业务编排收敛分票实施)。成功、失败、重试预留和预算续做均扣账；原startedAt恢复不重设，实际deadline同时受单段和剩余累计活跃时间限制。后台等待不计活跃时长，不调用模型询问进度。
- 旧版没有交付合同的检查点保留标注过的 savedProcessing 兼容路径；其余新合同恢复按真实等待步骤处理。后续工作区切换与兼容退出核验属于OPT-37。

## 验收映射

| 标准 | 证据 |
| --- | --- |
| R36-1 | 参数化HTTP：单份及两份各5条，先保存方案后执行；后台完成准备真实采用卡，确认后自动进入下一份；定义、场景、数量及每份目标逐项比保存合同。固定执行期间模型编排请求为0，每份草稿/运行各一次。 |
| R36-2 | receipts单元覆盖同一动作同一步骤纠错、不同交付/修订不能互相遮盖、另一动作失败/新要求未保存仍失败。HTTP复用OPT35参数纠错、口头确认/保存失败及旧回执换参拒绝。 |
| R36-3 | 主HTTP在真实处理提交后模拟响应丢失，恢复原run/key；并发retry一成一拒，重复后台事件与重复确认均不重建/重复采用。旧版before/after-run及未知效果回执回归通过。 |
| R36-4 | 503/429/network、Retry-After、取消与撤权、原时间/执行恢复上限及处理补齐耗尽回归通过。新增总重试25→26后不再派发下一retry、剩80ms deadline裁剪、末段35ms工具耗时结算、跨新用户回合不重置累计数；13个固定读取跨工具预算服务端续做，只有初始规划1个模型请求。 |
| R36-5 | 主HTTP重读持久化检查点，模拟回合失败后并发重试，保留原步骤key/run及预算；处理未终态时重复事件无模型请求。已有过期执行器重领保留原deadline回归通过。未重启4217或宿主。 |
| R36-6 | 采用/发布仍经真实确认。已领取确认撤销（未提交/已提交两类）、撤权后重试、停止Retry-After、过期/字段变化/排除后采用、澄清等待与后台竞争回归通过；旧产物及真实采用/发布回执保留。 |

## 验证

- 51项单元测试通过，7个文件：assistant-execution-plan、assistant-execution-budget、assistant-execution-receipts、assistant-plan、assistant-delivery-seams、assistant-context、assistant-transport。
- 38个不同HTTP用例通过，位于 tests/integration/project-assistant.test.ts。按最新有效回归逐名合并，重复运行不重复计数；已被本次固定推进测试替换的旧标题不算通过。覆盖上表及直接受影响的OPT-18/21/22/25/29/32/35路径。
- TypeScript检查、服务端构建、受影响文件ESLint、git diff --check通过；最终文档/lifecycle检查一次，改动Markdown链接、表格、围栏检查通过。没有变更Mermaid或JSON文档示例。
- 未运行浏览器或真实模型。本票验证业务编排和安全边界，局部“下一次给正确参数”不代表真实模型纠错率；通用短提示、内容质量和用户界面闭环仍由OPT-37及原OPT-31各自验收。

主要命令（Node v24.20.0，以上述服务器仓库为工作目录）：

~~~sh
node node_modules/vitest/vitest.mjs run tests/unit/assistant-execution-plan.test.ts tests/unit/assistant-execution-budget.test.ts tests/unit/assistant-execution-receipts.test.ts tests/unit/assistant-plan.test.ts tests/unit/assistant-delivery-seams.test.ts tests/unit/assistant-context.test.ts tests/unit/assistant-transport.test.ts --exclude ".scratch/**" --silent
python3 .scratch/assistant-optimization/opt34-runtime.py node node_modules/vitest/vitest.mjs run tests/integration/project-assistant.test.ts --exclude ".scratch/**" -t "OPT36|OPT35|OPT-21|OPT-22 revokes|continues a fully parameterized|does not hide a rejected change|keeps an unknown write bound|OPT18 stops|keeps clarification paused|OPT-25 rejects stale.*adoption|OPT32 follow-up does not conceal|OPT-25 executes approved read|OPT29 recovers a.*run lost" --silent
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/eslint/bin/eslint.js src/assistant/agent.ts src/assistant/plan.ts src/assistant/fence.ts src/assistant/store.ts src/assistant/context.ts src/assistant/budget.ts src/assistant/receipts.ts tests/unit/assistant-execution-plan.test.ts tests/unit/assistant-execution-budget.test.ts tests/unit/assistant-execution-receipts.test.ts tests/integration/project-assistant.test.ts
npm run docs:check
git diff --check
~~~

实际运行分阶段保存JSON报告（忽略文件，同目录）：opt36-unit-closed.json；opt36-http.json；opt36-compatibility.json；opt36-final-http.json；opt36-review-recheck.json；opt36-known-read.json。最后三个/修复后的对应报告覆盖其已失效旧结果；没有隐藏或删除早期失败。

## 开发失败与审阅

- 意义红：基线中两份各5条在首份后台完成后卡在采用步骤，并发出3个额外模型请求后失败；修复后单份/两份完整流程均通过。初次新增测试有SQL字符串转义错误、累计预算可选字段类型声明问题，已修正。
- 首轮32项HTTP为27过5失败：恢复后的非法换参被规划反馈掩盖；旧非交付任务过早complete使后续上下文丢失；暂停时真实采用事实未同步；两项旧生成回执夹具仍提交新任务已停用的嵌套参数。分别修复错误判定/完成范围/只观察已发生回执，并将旧回执用例明确初始化为已持久化旧合同。随后发现旧夹具还断言v9，改为既有v10，未改运行配方。
- 旧“查询预算续做”脚本在固定读取可立即执行后不再形成旧路径，且开头主动提出澄清；改为纯固定读取回归，另加13个只读步骤跨预算的真实续做用例。后者不创建13个业务对象，复用一份隔离夹具。

最终实现一次Standards/Spec审阅，之后只复核命名问题：

| 轴 | P1发现与关闭 |
| --- | --- |
| Standards | 累计传输/活跃时间没有约束实际边界。已即时保存重试预留、裁剪有效deadline并保留原始计时基准；临界HTTP回归通过，定向复核关闭。 |
| Spec | 单份新交付无采用路径；成功尾部耗时漏计及重试累计窗口。已仅为新合同补齐单份核对/确认，在终态及原子让出检查点结算预算；单份/双份、尾部耗时、最后重试回归通过，定向复核关闭。 |

无剩余P0/P1。复核覆盖实际新增文件和工作树补丁，未重复全量审阅或扩展到OPT-37。

## 数据与限制

测试复用既有隔离runner，只连接 evalbase-agent-test 网络的测试PostgreSQL/MinIO；每次采用随机 assistant_* 数据库并清理该次数据库，对象限定测试bucket evalbase-opt34-only。app.inject中的4217字符串仅为测试Origin，不访问Owner页面。未写Owner数据库/bucket/会话，未变更现有验收容器和数据。GB摘录沿用OPT-35原文夹具；候选为可控模型数据，仅证明结构与流程，不宣称其GB语义质量合格。
