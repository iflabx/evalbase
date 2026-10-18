# OPT-35 交付目标与规划契约：实施验证

日期：2026-10-19。Implementation completed；Owner pending。

## 范围与代码身份

- 分支：codex/assistant-optimization；基线：488335288d4d8a8c039a1a55cff164346413ce92（OPT-34）。
- 应用仓库：/home/bistu/EvalBase/.worktrees/agent-data-processing。
- 本记录与源码同次提交，最终提交号见 Git 历史；源码和测试内容摘要 SHA-256：dcadf70edb9197f9b76d3d32d41b340946a56e54c5f26da7de08244ef270b798。摘要按下列清单顺序，以路径、NUL、各文件 SHA-256、换行拼接后计算。
- 清单：src/assistant/{agent,background,context,delivery-plan,plan,requirements,store}.ts；tests/unit/assistant-delivery-plan.test.ts；tests/unit/assistant-delivery-seams.test.ts；tests/integration/project-assistant.test.ts；tests/fixtures/assistant-gb-original-fragment.txt。首组按括号所列顺序展开。
- 未新增公开 API、表、依赖、运行时或 UI；未更新4217、合并 main 或推送。未执行 OPT-36/37，也未代签 OPT-31。

## 实现

1. 新生成规划提交 deliveries 业务目标。服务端分配稳定 deliveryId、校验独立集合/内部分类配额、计算整体数量，并编译既有有序步骤。唯一权威仍是 task.executionPlan 内生成步骤；摘要及模型事实从该处派生。
2. contractVersion:1 区分新合同。旧版已有计划保留兼容入口；新合同不允许回退为模型拼装嵌套生成参数。查询和已有输入处理保持原有业务工具。
3. 省略保留原目标及字段；局部规则修改按具体字段/key 和用户当轮原话授权，显式保留优先。数量修改保持身份、未变语义及已有真实回执，并沿用现有修订/确认失效规则。
4. 参数纠错保留全部交付、分类、定义、配额及字段保护。原错误数量可以先原样进入业务校验被拒，或按用户明确数量纠正；不能据错误模型参数禁止合法纠正，也不能凭空缩减目标。
5. 首次交付使用 OPT-34 已读取的真实定义目录，检查明确命名类别的各 N 条要求，防止空分类绕过。合法引用先经 OPT-34 resolver 验证、恢复正文，再比较定义；没有第二套文档解析器或输出形式解释器。
6. 成功摘要以 updateTask 真正保存结果为准；只口头确认、无效引用、空计划及持久化失败不显示方案成功。规划模式不创建草稿或处理运行。

## 验收映射

| 标准 | 定向证据 |
| --- | --- |
| R35-1 | HTTP：GB A.1.a/A.1.b 两个独立目标各5，整体10；错误引用和清空分类被拒后完整纠正。实际项目草稿/运行计数未变。 |
| R35-2 | HTTP：客服规范一份6条，退款/物流各3；先提交空分类被拒，完整合同保存并刷新一致。 |
| R35-3 | 模块：目标删除/合并、丢定义/类别、无授权改变正文或其他Metadata键、缩增数量及字段保护；实际用户取消允许。HTTP：拼写归一、错误5按原话3纠正、无效引用纠正。 |
| R35-4 | HTTP：各3、总共6，身份与定义保持；重复提交同一合法引用及新配额成功。seams：已执行步骤 new→final 时保留回执且新语义与指纹一致；摘要从保存合同导出。 |
| R35-5 | HTTP：口头“已保存”不产生成功；注入保存故障保留前次有效合同并撤销旧确认资格，无草稿/运行写入。模块拒空目标/配额冲突；原有纠错预算与中断回归通过。 |
| R35-6 | 既有 HTTP：当前来源事实重建与查询、已有输入清洗/定义冻结继续通过；不强制额外交付。 |

## 验证结果

- 90 项单元测试通过，1 项可选本地PDF夹具测试跳过（未配置该外部路径）；同文件的合成PDF提取回归通过。5 个文件：assistant-delivery-plan、assistant-delivery-seams、assistant-plan、assistant-background、assistant-tool-repair。
- 7 个不同 HTTP 场景通过，选自 tests/integration/project-assistant.test.ts：4个 OPT35 场景、OPT34 delegated output contract、OPT-23 verified background definitions、OPT-23 current source facts。后续变更仅重跑直接受影响用例，最后合法引用与数量更新回归1/1、其他受影响入口3/3均通过；不将重复运行计入不同用例总数。
- TypeScript检查、服务端构建、受影响文件 ESLint、git diff --check 通过。最终文档检查及 Markdown 链接/表格/围栏检查通过；未更改 Mermaid 或 JSON 文档示例。
- 未运行浏览器或真实模型：本票无界面改动，真实短提示闭环按已定合同集中在 OPT-37；不能由可控重放推断模型永不出错或实际内容质量已通过。

命令（在上述服务器仓库，Node v24.20.0）：

~~~sh
node node_modules/vitest/vitest.mjs run tests/unit/assistant-delivery-plan.test.ts tests/unit/assistant-delivery-seams.test.ts tests/unit/assistant-plan.test.ts tests/unit/assistant-background.test.ts tests/unit/assistant-tool-repair.test.ts --exclude ".scratch/**" --silent
python3 .scratch/assistant-optimization/opt34-runtime.py node node_modules/vitest/vitest.mjs run tests/integration/project-assistant.test.ts --exclude ".scratch/**" -t "OPT35|OPT34 saves|OPT-23 reuses verified background definitions|OPT-23 rebuilds current source facts" --silent
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json
node node_modules/eslint/bin/eslint.js src/assistant/agent.ts src/assistant/delivery-plan.ts src/assistant/plan.ts src/assistant/requirements.ts src/assistant/background.ts src/assistant/context.ts src/assistant/store.ts tests/unit/assistant-delivery-plan.test.ts tests/unit/assistant-delivery-seams.test.ts tests/integration/project-assistant.test.ts
npm run docs:check
git diff --check
~~~

实际机器报告位于同目录忽略文件 opt35-unit-complete.json、opt35-http.json、opt35-http-edge.json、opt35-equivalent-ref-green.json、opt35-canonical-ref.json；静态检查日志前缀 opt35-final-* / opt35-ref-static。最终按修复后的对应报告判断，早期失败不覆盖删除。

## 开发失败与审阅

- 红阶段：新 deliveries 请求被旧规划入口拒绝；修复后客服/双集合 HTTP 保存通过。单元初次存在断言读 Error.message 而非 hint 的测试写法问题及引用输入类型声明不足，已更正。
- 首次7项HTTP有2项失败：保存失败回归需保留正确的 needsReview:true；撤销期望输出分类时，旧规则合并回投影。分别校正安全状态断言及完整目标投影，复测通过。
- 审阅补修中新增回归捕获 SDK 无损拼写归一被数量守卫过早中止，以及后续编辑把目录父标题“分类”当具体类别。已将结构归一与业务数量校验分开，目录完整性约束限定首次交付，已有规则更新继续由字段/key授权保护；复测通过。
- 合法引用回填回归先红后绿：原合同保存为正文，后续同一合法reference被误判正文变化；现先使用同一OPT34 resolver验证归一，再比较，未放宽错误引用或正文篡改保护。

最终实现只做一次 Standards/Spec 全量审阅，随后仅针对发现复核：

| 轴 | 发现及关闭证据 |
| --- | --- |
| Standards | P1：泛Metadata授权可误清其他key；已执行步骤保留分支丢失新countKind。已按字段/key授权并尊重显式保留；保留回执同时同步语义。19项相关模块/seams回归通过，定向复核关闭。 |
| Spec | P1：错误模型5阻止按用户3纠正；无关字段撤销；同值定义被无授权改写；初始空分类绕过明确类别配额。均已修复并回归。定向复核追加发现合法引用等价回填回归，亦已修复、红绿验证关闭。 |

无剩余 P0/P1。本次审阅未扩展到后续执行编排或UI切换。

## 数据与限制

HTTP测试复用隔离 runner，只连 evalbase-agent-test 网络的测试 PostgreSQL/MinIO，使用随机 assistant_* 数据库并在结束删除该次数据库；对象写入限定独立测试bucket evalbase-opt34-only。没有操作 Owner 数据库、bucket、现有会话或4217容器。客服夹具沿用OPT34；GB夹具取自既有 A/B 原始 read_background 轨迹的附录A页面摘录，未用自编甲乙定义替代。

有限原话检查处理明确集合份数、共N/各N、局部撤销和已知类别配额，不宣称能用规则理解任意自然语言。真实模型规划成功率、完整执行及用户界面接入属于OPT36/37后续范围；不增加无限纠错循环。
