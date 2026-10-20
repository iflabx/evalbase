# OPT-42 实施与定向验证

日期：2026-10-20。应用提交：`93de778c57edc3459fc4ada1b454b6fb585a4691`。Implementation completed；真实交互验证 partial，Owner pending。合同见[OPT-42](issues/42-intent-control-and-compound-requests.md)。本轮按Owner决定不验证生成内容质量。

## 范围与最小实现

- 保留AI SDK、现有task JSON、工具、Worker、修订、回执及累计预算；无新表、公开路由、意图模型服务、依赖或通用工作流。
- 在原plan_task增加control，表达query/plan/execute/pause，变更要求与暂停顺序可组合。主模型使用现有请求决定；服务端绑定回合/修订，工具可见性、实际副作用及advanceExecution共用决定。未知决定只读且不能成功结束，pending阻止后台续步；纯查询无需业务计划或新要求。
- 合法的control-only query沿读取权限，查看角色不能借此修改业务字段。明确执行/恢复按钮在原turns请求增加operation并核对权限、修订和实际状态；三个旧固定标签仅兼容旧客户端。
- 修改先真实保存后执行；失败不沿旧参数推进。先暂停后改要求，即使变更失败也保留暂停。查询不改固定输入范围或结算旧步骤，不永久暂停。无工具回执的“已暂停/已修改”不能成功收尾；没有新增无限重试。
- 使用经校验本轮修改意图更新真实交付ID的数量，不再通过历史数字/关键词二次授权。明确的完整当前要求替换旧语义，省略时保留；原字段、配额、分类和文档证据守卫保持。
- 新修订只重置尚未提交的失效确认准备步骤，清除旧确认绑定后按当前状态重新准备；已提交回执仍保留且不重跑。
- 前端仅3行请求/类型变化，无视觉或组件布局变化，继续使用frontend-v1现有风格；无新增面板、常驻卡片或配置。

## 环境与数据保护

- 服务器工作区：/home/bistu/EvalBase/.worktrees/agent-data-processing；分支codex/assistant-optimization；开发基线38cbd136313525965b8e096d57e96c4545bd0571。只提交本票代码/记录，无合并或推送。
- 合成接口测试使用evalbase-agent-test随机独立数据库，测试结束仅删除自己创建的临时库。真实验证写入独立库opt42_4710a50037dc42368cdb4229618b2ab1，桶opt39-isolated-tests；该库、背景文档、失败与原始预算保留。
- 真实新项目project_ebda26e8883247c2bfaf9a062463560e；会话conversation_a7a66bf2b3fa47749b82cbb0c55984dd；运行processing_4c21cf35b5d84cab9a7b6f6e36ae495d。只有1个运行、2条候选、1个空草稿，采用0、发布0。
- 原Owner验收库只读取既有模型连接，没有写入原项目/会话。248/400条记录、旧失败及原预算未重跑或重置。原owner-snapshot.json文件SHA256仍为440f3aeeec47cdc8121c28de4d408fd265dc2a23e1ceb811888dacc1770f0196；该文件哈希不冒充全库逐字节对比。
- 未更新4217；仍保留[39–41联动记录](opt39-41-checkpoint.md)中的0522efefb2773c54bb3296a330fd24ecb5514c17。4220仅为本次临时隔离验证服务，不是4217部署交付。

## 自动化与审阅

Node24。集成通过现有opt39/run-tests.py注入隔离PG/MinIO配置，无Owner库写入或真实模型调用。

| 检查 | 结果与证据 |
| --- | --- |
| tests/integration/assistant-intent.test.ts | 最终31/31通过，日志opt42/intent-verified.log。实际HTTP登录、消息/控制入口及持久状态；模型响应用可控服务，不代表自然语言实测。 |
| 受影响既有领域单元 | 7文件68项，67通过、1个基线失败；未宣称全仓库绿。见下文。 |
| 根项目/前端类型 | tsc --noEmit及tsc --noEmit -p frontend-v3/tsconfig.json均exit0，opt42/static-final.log及各.exit。 |
| 受影响10个TS/TSX文件ESLint | exit0，同一static-final结果；没有运行全仓库lint。 |
| 正式前端构建 | npm --prefix frontend-v3 run build:formal通过，opt42/frontend-build.log；之后只将同一按钮条件改为可选链以满足类型检查，最终前端类型/lint通过。 |
| 文档/差异 | 最终受影响Markdown链接、表格、围栏核对及docs:check、git diff --check；结果随记录提交。未改JSON文档示例或Mermaid。 |
| Standards/Spec | 同一基线两轴审阅；查询误写范围、失效确认待办卡住、旧事实冒充新要求回执、非字符串mode、查看权限误拦均已修复并只复查对应发现。无剩余本票审阅finding。 |

最终公开接口31项覆盖：查询/解释及引用、只规划、修改后执行/保存失败、失败后旧事件、暂停先行及失败保持、解释先于执行、歧义澄清、按钮与旧标签、未知/过期控制、CSRF/幂等、只查询固定范围、失效确认恢复、当前要求替换和数量更新、无控制回执的口头暂停，以及真实查看角色查询与拒绝执行/混入字段。断言实际副作用和持久状态，未仅检查提示词。

复现命令（在该工作区，使用既有隔离测试配置）：

```sh
python3 .scratch/assistant-optimization/opt39/run-tests.py /home/bistu/.local/share/agentbench-v2/node-v24.20.0/bin/node node_modules/vitest/vitest.mjs run --dir tests/integration tests/integration/assistant-intent.test.ts
node node_modules/vitest/vitest.mjs run --dir tests/unit tests/unit/assistant-plan.test.ts tests/unit/assistant-continuation.test.ts tests/unit/assistant-execution-budget.test.ts tests/unit/assistant-execution-receipts.test.ts tests/unit/assistant-execution-plan.test.ts tests/unit/assistant-tool-repair.test.ts tests/unit/assistant-tool-repair-runtime.test.ts
```

领域基线失败：assistant-execution-plan的“keeps a waiting real run until that exact run completes”，期望current=1，实际3。同一用例在38cbd13归档基线也失败，相关plan实现/该测试本票未改；分别保留opt42/domain-focused.log、opt42/baseline-fixture.log。不扩围修无关夹具。

## 同一新会话的有界真实Computer Use

模型qwen-new、连接修订2；新上传非GB的物流测试说明，要求自然中文、物流查询/改地址、问题及期望处理方式，无真实个人信息。没有使用内部工具参数提示或旧验收数据生成。

统一上限12次实际HTTP请求、累计300000ms活动时间、最多2条新候选。实际12次、30350ms；规划、生成、已有处理审核和自动步骤全部记账，无额度重置、换会话或额外请求。既有处理流程的审核请求计入消耗，但本轮不评价其内容质量。

| 顺序 | 用户普通提示 | 实际请求 | 观察 |
| --- | --- | --- | --- |
| 1 | 按附件做2条物流问答测试，先给方案，不生成。 | 1–4 | 保存目标2及方案，零运行、零草稿。 |
| 2 | 改成1条，先不执行。 | 5–6 | 失败：旧数量更新又从短句/历史数字推断授权。旧失败保留。 |
| 3 | 重试刚才的数量修改，先不执行。 | 7 | 修改后保存目标1，零运行；仍观察到旧“各1条”要求残留，随后修复当前完整要求替换。未重跑已完成的数量修改。 |
| 4 | 现在是多少条？只查看，不执行。 | 8 | 正确答1条，未新增业务执行。 |
| 5 | 改成2条，然后执行。 | 9–11 | 使用新目标2和当前要求，新增1运行/2候选，自动零模型步骤准备采用卡；采用0、发布0。 |
| 6 | 先暂停后续执行，再解释当前状态。 | 12 | 模型口头称已暂停，却未提交控制；当时旧边界容许无工具回复完成，实际未暂停，旧卡因新修订失效。判失败，未按文字算通过。 |
| 7 | 根据实际待办继续 | 未运行 | 请求上限已到，不另开预算或会话。 |

真实请求发生于38cbd13基础上的开发工作树，数量修改、要求替换等修复之间仅重启同一隔离服务继续原会话；不是固定最终代码的一次通过。原预算code字段记录的是当时HEAD，不应误读为未提交源码版本。最终固定应用代码93de778另有上述31项回归，不能倒填为全部真实流程已过。

最后的口头暂停漏口已在93de778修复：普通用户回合没有决定时，原主模型只可读/提交控制并使用原生必选工具约束；仅文字不能成功结束，原一次纠正仍无控制则明确失败，pending禁止自动推进。纯查询可在控制回执中直接答复，避免再追加一次总结调用。对应有控制暂停、无控制失败、后台不续步及查看角色回归均通过；**修后真实暂停/继续没有剩余额度复测**。

工作区截图只证明当时生成2条、未采用及保留状态，不证明暂停修复或内容质量通过：

![隔离会话中两条候选、零采用](opt42-browser-results.png)

原始预算、模型请求与失败记录保留在服务器opt42/semantic-budget.json、semantic-results.json、live.log及同一隔离库；不提交私有连接配置或凭据。

## 完成口径与下一步

- 应用代码和定向回归完成；R42-1–8及10以固定自动场景验证，实际自然语言证据限上述输入，不能保证任意中文零误解。
- R42-9 partial：生成链路实际完成2条，但暂停/继续修后未完成真实复测，整票验收和Owner签收未完成。不能用Mock、代码审阅或口头回复代替这项证据。
- 本次不再追加真实调用、不重跑已完成生成，不改变旧质量门槛。需要后续另行授权的有界验证/4217更新时，复用既有成果和失败记录，仅验证剩余边界。
