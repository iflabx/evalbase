# OPT-39 实施与定向验证

日期：2026-10-20。Implementation completed；Owner 人工验收 pending。

- 实施分支：`codex/assistant-optimization`，工作区 `agent-data-processing`。
- 实施基线：`24eeaebb5cf8470518956b7119556e713e558484`。
- 应用与测试提交：`ad9a093d81bb5fbb3179c788deee574bed04cced`。
- 授权与验收合同见 [OPT-39](issues/39-delivery-review-scope-and-continuation.md)。本轮未切换4217、合并、推送或部署；4217仍是原Web `ddb0b64d827a429fd7486528b7c2ac519bca4d15`。

## 实现

1. 从同交付步骤回执和处理根运行确定所属合同；终态保留最后真实交付焦点。不可证明归属时拒绝当前资格，不按名称或首项猜测。
2. 逐运行核对当前资格，保留冻结历史模型结论。共同约束保持、仅修改H时，A已完成步骤的真实输入及保存回执保持；改变共同要求仍重新核对。没有新增审核服务、表或公开路由。
3. 队列和执行入口共用已提交确认对账。最后确认即使发生在旧12次或新冻结上限，也直接收尾，不为总结分配新回合，不重新保存。
4. 新任务用JSON中可选的 `autoEventLimit` 表达批准方案的异步/确认节点数加最多2次恢复余量，开始执行时冻结；同步读不虚增次数。缺少字段的旧任务仍按12次，原模型/工具/时间预算、修订与事件累计不变。未完成工作增加且超出原额度时先暂停，包含总步骤数不变的重规划。
5. 复用现有frontend-v1组件表达暂停原因、历史核对与当前资格；预算耗尽时不提供必定失败的继续按钮。“已保存”不等于内容或人工审核通过。

## 验证与验收映射

所有新增写入只在 `evalbase-agent-test` 的独立随机数据库和 `opt39-isolated-tests` 存储桶中；受控响应使用本地假模型，不调用真实Qwen。未写入Owner数据库，未生成新400条或重跑原成果。

| 验收 | 证据与结果 |
| --- | --- |
| R39-1 | 对实际保留的Owner冻结快照执行当前兼容函数：H历史模型核对50条、符合50条；H单看及A/H分别核对均兼容。快照SHA256为 `440f3aeeec47cdc8121c28de4d408fd265dc2a23e1ceb811888dacc1770f0196`，回放前后相同；零模型调用、零数据库写入。注意这是历史模型意见，不是内容质量或人工通过。 |
| R39-2 | 单元回归覆盖H变更、A保留、未知归属阻断；公开接口八交付回归在模拟“保存已提交、终态尚未结算”的恢复窗口，只修改H规划要求，A完整生成/读取/保存输入及回执保留，H生成变为pending，无新运行。共同约束/字段保护/背景引用变化不享受保留。 |
| R39-3 | 真实数据库/对象存储/Worker与公开助手接口，八份各5条受控候选，逐份完成和确认，正常超过12次；冻结额度18，每份恰好一个运行及保存草稿，执行阶段零额外助手模型重规划请求。没有生成真实400条。 |
| R39-4 | 最后一次确认前模拟恢复余量用尽，autoCount=18；最后确认直接完成，重复确认/事件与刷新不新增回合或保存。旧任务12次上限的已提交确认也直接完成，原累计预算完全保持。 |
| R39-5 | 独立8项集成覆盖旧额度、重复事件、暂停、停止、旧修订、活动回合、会话容量、撤权和最后回执。扩规模及同规模重新安排已完成工作2项公开接口回归均提前暂停，额度/计数不变、无新处理运行。累计调用/活跃时间与旧执行回执守卫一并定向回归。 |
| R39-6 | 实际构建前端+隔离4220实例的Computer Use：完成态、已保存回执、助手/处理页相同5条读数、内容待核对、暂停原因及历史摘要；390px请求窗口实测clientWidth/scrollWidth均375，无整页横向溢出。暂停/历史展示场景只调整独立合成夹具，未伪造Owner50条审核数。 |

### 可复现命令与实际结果

在Node24工作区执行，集成命令通过本轮 `opt39/run-tests.py` 注入独立测试容器配置，配置值和密钥不输出。

- 单元：`vitest run --exclude '**/.scratch/**'` 加 assistant-plan、assistant-delivery-plan、assistant-review、assistant-contract、assistant-continuation、assistant-workspace、assistant-execution-receipts、assistant-execution-budget 八个单元文件：**96通过**。
- `tests/integration/assistant-continuation.test.ts`：**8通过**。
- `tests/integration/project-assistant.test.ts -t 'saved deliveries.*eight'`：**1通过**（八交付、最终上限和H单改均在该公开接口案例中）。
- 同文件 `-t 'OPT39 freezes event allowance'`：**2通过**（扩大方案、同规模新增未完成工作）。
- 同文件丢失生成回执的 `restored-run` 定向案例：**1通过**；单交付公开接口隔离浏览器夹具：**1通过**。重复运行不叠加宣称覆盖数量。
- `tsc --noEmit`、受影响文件ESLint、`git diff --check`、`npm --prefix frontend-v3 run build:formal`：通过。最终修复后的单元/类型退出码0。
- 冻结回放：`opt39/frozen-replay.ts` 结果为 `opt39/frozen-replay.json`，仅本地快照运算。

原始日志保留在服务器本工作区的 `.scratch/assistant-optimization/opt39/`：review-unit-types、events-green2、review-fix-eight2、review-fix-cap5、restored-green4、frontend-build及各exit；格式/lint结果见本地执行日志final-lint-status。初始审核归属测试先红后绿。

### 失败与边界如实保留

- 整合审阅发现“真实H编辑会清除A绑定读取/采用回执”和“总步骤不变时遗漏剩余额度检查”，均已补修，相关公开接口回归通过；Standards与Spec均窄复核通过，无剩余发现。两位审阅代理只读检查，没有代跑或代签模型质量。
- 原 `tests/integration/assistant-tasks.test.ts` 整文件当前为4通过/18失败；在完全未改的24eeaeb归档基线也为相同4通过/18失败。首项旧refine夹具的child为空及后续关闭app的级联失败均保留，不能写成整个集成套件通过。新建独立集成文件覆盖本票核心队列边界。本轮不顺带修复原整文件夹具。
- 边界回归前置曾触发既有“先给方案”文档读取门禁、未读背景，以及缺少requirements的工具结构校验；修正为真实草稿上下文、完整受控结构，验证本票额度逻辑，不把这些前置失败当成额度实现失败或短提示泛化通过。
- 内容质量、漏检和新题生成边界仍由OPT-40/41负责。原OPT-31八份400条“已保存、质量未通过”状态不变；原248条历史、所有预算和失败证据保留。

## 浏览器证据

会话为隔离库合成5条，非原400条Owner会话；实际前端使用本次构建，后端运行本次源码。暂停/历史场景使用测试适配脚本设置已存在的任务JSON，展示历史核对0条，未冒充50条人工通过。只读检查完成后关闭4220临时实例与隧道，删除本轮专用浏览器夹具库；4217保持原样。

- [桌面完成态及结果](opt39/browser-desktop.png)
- [窄窗口](opt39/browser-narrow.png)
- [暂停及历史核对](opt39/browser-paused-history.png)
- [同一处理页结果](opt39/browser-processing.png)

本记录是开发和定向验证证据，不代替Owner人工验收；未通过的内容质量事实不改签。
