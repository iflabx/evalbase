# OPT-34 实施与定向验证

日期：2026-10-18。Owner 单独授权本张开发及定向验证。Implementation completed，Owner pending。

## 1. 范围与身份

- 工作区：/home/bistu/EvalBase/.worktrees/agent-data-processing；分支：codex/assistant-optimization。
- 基线：016cc638b1418f84bb0567c23c4a17add190e4ab；交付为包含本记录的 OPT-34 实现提交。
- 最终五个已跟踪代码/测试文件相对基线的补丁 SHA-256：2390a3a6dbd4f25663cc8cddafd9594a6846a1f11008d1ebee1483769f60ff91。另有下述新夹具。
- 仅修改文档解析、引用与输出约定校验、直接调用方提示及相关测试。保留 AI SDK 与现有业务结构，无新依赖、公开 API、表或数据迁移；未实施 OPT-35–37。
- 本轮未调用真实模型、未运行浏览器流程、未更新4217，也未合并或推送。测试连接仅取 evalbase-agent-test 的 PostgreSQL/MinIO，使用随机 assistant_ 测试库及 evalbase-opt34-only 桶；测试退出仅删除自己创建的数据库。未读写 Owner 业务库和验收文件。

## 2. 实现

- Markdown 列表排版标记仅从规范名称中移除，原始定义及页/行定位不变；A-1 等真实连字符保留。可证的原始列表名称仍作兼容别名；同名歧义、邻项错绑和错位表格继续拒绝。
- 新引用绑定项目、用户、个人会话、文档哈希/提取版本和原文条目。已登记的旧规则引用重算原始绑定后兼容读取，不接受未登记旧令牌；按字段缓存验证，输出形式修改不使独立 Metadata 引用失效。无法恢复的引用保留历史文本，要求重读，不改库迁移历史会话。
- 按用户实际原话的先后顺序采用明确输出选择或附件委托；只读取已确认片段中的输出声明。附件明确列出的标签与当前期望输出值精确核对；仅修改问题/Metadata 的局部委托保留既有明确输出选择。逐题行为不因类别标题被固定成标签，Metadata 分类独立。
- 更新现有工具说明与诊断，提示版本 v11、工具版本 v9；不改变工具参数和操作权限。方案保存及暂停沿用现有修订/执行保护。

## 3. 验收映射

| 验收 | 定向证据 |
| --- | --- |
| R34-1 | 使用对照原始客服规范夹具，SHA-256 c71865e5421a4d0b591fb9d082b9caf644bcec99350be7721a8ba17430623833。真实目录引用可使用退款申请/物流查询，HTTP 上传、读取、保存后仍有原始列表和第1–13行定位。 |
| R34-2 | 单元重放 -、*、1. 列表；保留 A-1/A-2；复用相邻定义、重名、错位/缺项表格及 GB 层级回归。 |
| R34-3 | 已读附件输出约定、无委托/未读输出片段/模型自报/过期依据的拒绝、逐题自然语言与 Metadata 分离、普通文档、冲突声明、固定输出枚举与其他类别分离。 |
| R34-4 | 单元覆盖后续改形式、重新委托输出和仅改问题的保留路径；HTTP 修改输出后保留 Metadata 规则及总数6，真实要求持久化，暂停且无下一执行动作。 |
| R34-5 | 单元覆盖错条目、跨项目/用户/会话、哈希/提取版本/片段变化、旧引用登记及附件操作文字不提供输出授权。HTTP 覆盖跨会话、删除后拒绝、个人资料隔离、撤权、容量和冻结原文；仅记录要求/方案期间草稿与处理任务数量相对原基线未增加，无待确认操作。 |

相关文件：[单元测试](../../tests/unit/assistant-background.test.ts)、[HTTP 测试](../../tests/integration/project-assistant.test.ts)、[客服原始夹具](../../tests/fixtures/assistant-customer-intent.md)。

## 4. 最终检查

| 检查 | 结果 |
| --- | --- |
| 单元：assistant-background、assistant-requirements、assistant-plan | 61通过，1个可选真实PDF路径用例因未提供环境路径跳过；现有合成PDF提取回归通过。 |
| HTTP：OPT34；document capacity and personal isolation；OPT-23 current source facts；OPT-23 verified background freeze | 4通过。先运行已有草稿用例，核对新回归不依赖空项目。 |
| TypeScript --noEmit | 通过。 |
| ESLint 五个受影响 TS 文件 | 通过。 |
| 后端 tsc -p tsconfig.server.json | 通过。 |
| Prettier 受影响 TS、git diff --check | 通过。 |
| 文档链接/表格/围栏及 docs:check | 通过，命令记录见下。无 JSON 示例或 Mermaid 变更。 |

使用 Node24.20.0；既有 node_modules。单元命令：

~~~sh
node node_modules/vitest/vitest.mjs run tests/unit/assistant-background.test.ts tests/unit/assistant-requirements.test.ts tests/unit/assistant-plan.test.ts --exclude ".scratch/**" --silent --reporter=json --outputFile=.scratch/assistant-optimization/opt34-unit.json
~~~

HTTP 通过现有隔离配置启动；仅提供测试 PostgreSQL/MinIO 配置，不加载真实模型密钥：

~~~sh
python3 .scratch/assistant-optimization/opt34-runtime.py node node_modules/vitest/vitest.mjs run tests/integration/project-assistant.test.ts --exclude ".scratch/**" -t "OPT34|enforces document capacity and personal isolation|OPT-23 reuses verified background definitions|OPT-23 rebuilds current source facts" --silent --reporter=json --outputFile=.scratch/assistant-optimization/opt34-http-final.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/assistant/agent.ts src/assistant/background.ts src/assistant/background-sections.ts tests/unit/assistant-background.test.ts tests/integration/project-assistant.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.server.json
npm run docs:check
~~~

运行器与原始测试日志保留在本工作区 .scratch/assistant-optimization/opt34-*；凭据未写入报告或提交。初始 red 复现列表名和附件输出委托失败；边界 red 复现问题字段串用及旧 Metadata 引用失效；审阅 red 复现明确输出枚举错绑、后续委托顺序和局部更新保留。均在最终定向集转绿。

HTTP 开发阶段另修正用例本身的窄规划 schema、必填 scenarios/requirements、公开响应字段和共享项目基线假设；曾因模拟模型后续默认建草稿导致隔离测试数量断言失败，改用“只记录要求”的真实受限入口核对失败引用。那些失败不作为最终通过，未触及验收库。

## 5. 最终两轴审阅

范围为基线至工作区实际差异，含新夹具；共享解析/校验边界纳入同次审阅，无第二轮完整审计。

### Standards

未发现 P0/P1。1项 P2：HTTP 用例依赖项目总数为0，改为原有数量基线比较并以已有草稿前置用例验证。1项可选判断：旧定义重复计算，改为函数内按字段缓存。两项定向复核关闭，无剩余发现。

### Spec

2项 P1：附件输出标签范围未核对、后续输出委托被旧形式覆盖。已补充精确标签核对和按实际请求顺序选择；针对修复又补齐“仅改问题多样性，其他要求不变”的保留回归。独立定向复核确认原两项及局部更新回归关闭，无剩余阻断项。

汇总：Standards 两项已关闭，无剩余 P0/P1；Spec 两项 P1 及其直接回归已关闭。此结论仅适用于 OPT-34 的当前内容。

## 6. 交付限制

本轮证明当前支持格式在可控模型与隔离业务接口上的合同一致性，不保证任意文档语义或模型总体成功率。复杂/矛盾约定仍须澄清，不猜测缺失定义。真实短提示、生成采用及工作区闭环集中在 OPT-37；OPT-31 内容质量和原八类验收仍未代签。4217沿用原版本、现有验收数据保留，Owner 本张验收 pending。
