# OPT-17 实施与验证记录

- 日期：2026-10-13；Ticket：[OPT-17](issues/17-processing-task-rounds.md)。
- Implementation：completed；Owner 验收：pending。
- 分支：`codex/assistant-optimization`；基线：`44815546baf10e6d5a5097086fbd67cc4cf75d8f`。
- 固定应用提交：`6c1dafe011e936b96229e7c6790b44e25c432035`。后续文档提交不改变运行代码。
- 范围：正式 frontend-v3、必要的持久任务归属及当前结果引用、现有处理/保存服务和定向测试；frontend-v1、冻结原型只读，无新增依赖、版本树或流程框架。

## 实施内容

1. 连续处理共用稳定任务和工作区；列表按任务聚合后搜索、筛选及分页。每次明确继续、补齐或重新运行记一轮，自动重试不增加用户轮次。
2. 当前成果按稳定记录身份替换或追加。未选记录、处理失败的旧值保留；扩写参考输入不冒充新增成果。重做最新轮使用该轮固定输入及执行前集合，替代其效果。
3. 历史通过 donor Sheet 按需分页读取，只读展示实际轮次输出。旧链接定位对应轮次；旧数据仅按可证明父子单链归组，分叉保持独立入口。
4. 保存基于当前有效集合及实际选择，沿用权限、最初字段基线、事务、幂等和真实回执。去重删除须明确确认；成功提交的原草稿删除清单不会在第二次部分保存中重复执行。
5. 全部成果已保存到同一草稿且回执可证明时，提供“基于已保存草稿继续”，从实际保存范围读取当前内容和新修订。同一任务的启动与保存互斥，旧配置不能覆盖新状态。

## 验证结果与范围

| 检查 | 结果 | 实际范围 |
| --- | --- | --- |
| 服务端集成 | 44 passed | processing-task-rounds 7、processing-runs 16、assistant-tasks 21；单 worker，可控 HTTP 模型与隔离库 |
| 浏览器 | 15 passed | loading-experience 6、processing-continuation 5、processing-deduplication 2、processing-task-rounds 2；确定性 API 夹具 |
| 类型 | passed | 根目录及 frontend-v3 TypeScript |
| 受影响 lint | 无错误 | 新代码无 Hook 警告；processing-review 原有 react-refresh 导出警告 1 项保持 |
| 构建 | passed | 4317 预览及 git archive 固定代码的正式 Web/服务端 Docker 构建 |
| 截图 | checked | 1440px、480px 工作区及短表列表；复用 donor 样式，页面无横向溢出 |

定向集成命令：

```sh
npx vitest run tests/integration/processing-task-rounds.test.ts tests/integration/assistant-tasks.test.ts tests/integration/processing-runs.test.ts --exclude '.scratch/**' --maxWorkers=1
```

定向浏览器命令在已有 Playwright 1.62.1 Chromium 容器内运行，单 worker、4317 前端预览：

```sh
npx playwright test e2e/loading-experience.spec.ts e2e/processing-continuation.spec.ts e2e/processing-deduplication.spec.ts e2e/processing-task-rounds.spec.ts --workers=1
```

测试身份和资料只存在于隔离临时库，不增加 Owner 验收账号或项目，不调用真实模型生成大批内容。44 项覆盖实际 Worker 结果、HTTP 权限及保存服务；15 项浏览器使用 API 夹具，不冒充真实模型端到端生成。

| AC | 证据与边界 |
| --- | --- |
| R17-1/2 | 单任务列表、100 条选 10 条保持其余 90 条、扩写追加、当前集合保存；浏览器稳定工作区和跨页选择 |
| R17-3/4 | 失败保留旧值、重试不增轮、重做不重复累计；已有成果与本轮有效数量分开、补齐缺口及页面刷新 |
| R17-5/6 | 全量保存、分批去重删除仅执行一次、已保存草稿新基线、未知回执同键核对；助手采用回归保持 |
| R17-7 | 管理员/编辑同时提交仅一方 201，另一方 409；启动与保存竞争、过期修订及首读/来源清理竞争 |
| R17-8 | 单链按父子顺序迁移、分叉独立、重复迁移、旧输入/哈希不变；浏览器只读历史和返回后选择保留 |
| R17-9 | 列表单任务统计及五类状态浏览器回归；服务端代码核对聚合先于最近 100 项截取，不另做百任务负载测试 |
| R17-10 | 未授权读取 404、来源清理、现有助手 21 项回归；桌面/窄屏、来源弹层焦点及错误反馈 |

未失效的确定性去重、模型调用预算及 donor 列表证据复用 [OPT-16](opt16-verification.md)。初次回归发现旧标题/确认字段断言，按当前合同更新；另修复首轮运行中提前初始化零选择的问题。助手近预算夹具由恰好 39,999 字节改为大于 39,000 且不超过 39,999，仍检查实际末批范围，避免新增提示被裁剪后断言错误。最终上述文件全部通过。

## 一次两轴审阅与修复

Standards 与 Spec 对同一实施 diff 分别审阅一次；下列发现均已修复，并复核对应回归，无剩余已知 P0/P1。修复后不重复完整审阅。

| 轴 | 原发现 | 修复与复核 |
| --- | --- | --- |
| Standards P1 | saved 续处理/保存锁顺序相反，首读更新 run 与来源清理存在反向锁 | 启动先取得任务守卫，再锁来源；首读释放 task 锁后更新历史元信息；两类并发用例通过 |
| Standards P2 | 历史保存数量累加幂等回放别名 | 按唯一候选身份统计，保留真实回执 |
| Spec P1 | 补齐误用整个任务成果数 | 返回本轮有效数；已有 10 条加不足 8 条扩写仍正确补缺口 |
| Spec P1 | 去重后第二次部分保存重复删除已移除原行 | 成功后原子移除已执行排除引用；分两次保存通过 |
| Spec P1 | 补齐后同一路由详情不刷新 | 提交后刷新当前详情；浏览器验证最新轮状态及轮次增加 |
| Spec P2 | 原草稿删除确认把所有排除项计作删除 | 仅统计目标原草稿实际待删除记录，生成候选排除不冒充原行删除 |
| Spec P2 | 未处理输入可误选，首轮终态仍默认零选择 | 禁止采用未处理旧值；首次终态初始化实际未保存成果，刷新/历史不重置选择 |

## 4217 固定版本与数据保护

- Compose project：`evalbase-agent-owner-checkpoint`；原数据库 `agent_owner`、桶 `agent-owner-checkpoint`、loopback 4217 保持。
- Web、Worker、Model Worker：`evalbase-agent-checkpoint:6c1dafe011e9`，image ID `5fb1f0330403`；应用身份均为固定代码提交。
- `/health`、`/health/ready` 均返回应用完整 SHA；PostgreSQL/MinIO ok，Web healthy，两 Worker running。主 JS `index-BUgetWT5.js`、处理页 `projects._projectId.processing-DeXpcSou.js` 及安装接口返回 200。
- 切换前确认活动 job/助手 turn 为 0。只替换三个应用服务，不清理或重建数据库/桶；原环境文件备份为服务器 `.scratch/agent-data-processing/checkpoint.env.opt17-backup`，权限 600，不提交秘密。
- 切换前后一致：账号 2、项目 2、草稿 17、运行 80。迁移得到 62 个处理任务归属，80 次运行全部有归属；输入 ID/hash/ref 汇总哈希仍为 `1356a25b711bd6dbc0ac0a0582d3ba41`。任务归组没有删除历史运行或重写输入。
- 实时 Computer Use 复核既有 `processing_96eaba1866b14de5be7ef84e57b64910`：旧链接打开只读历史结果，返回当前工作区显示 110 条成果、2 轮；历史展示两轮真实要求，选择和当前成果保持。仅浏览，不启动模型、保存或排除 Owner 数据。

Owner 验收 pending，不改写此前验收记录；本轮没有新增验收账号或项目。

## 建议人工验收

1. 刷新 4217，进入“数据处理”。对少量所选结果连续清洗/改写/扩写，确认列表仍只有同一任务一行，当前成果替换/追加且未选内容保留。
2. 打开“轮次历史”，查看前一轮输出，再返回当前结果；确认只读历史、轮次要求及原选择位置。
3. 从测试集草稿发起处理，分轮修改后保存回原草稿，核对更新/新增/移除数量；全部保存后用“基于已保存草稿继续”。
4. 两账号同时提交同一任务，确认只有一轮生效；冲突时刷新范围后再操作。旧父子分叉不会强行拼成一个当前集合。

不提供任意历史回滚或分叉编辑。旧回执无法可靠证明实际保存记录范围时，不启用“基于已保存草稿继续”；使用真实草稿入口重新发起处理。结构/数量通过不代表生成语义正确，内容仍须用户核对。没有新增压力或长时稳定性测试。
