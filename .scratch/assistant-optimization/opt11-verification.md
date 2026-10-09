# OPT-11 实施与验证记录

日期：2026-10-09。Owner 授权完成 [OPT-11](issues/11-processing-workspace-ux.md)，沿用 `codex/assistant-optimization` 与同一 4217 隔离环境。审查基线 `c5cc0978f90018a69cad571079834c494f7066e1`。Owner 验收 pending；不包含 main 合并、GitHub 推送、tag 或正式部署。

## 实施及接口盘点

- 配置、任务列表、结果继续分开；来源摘要、真实要求和操作者可追溯。输入搜索、Metadata 筛选、只看已选、隐藏选择数与本页并集选择共用授权集合。
- 清洗／改写／扩充说明、字段保护、禁用原因和输入／新增数量分开。结果紧凑列表直接显示 Metadata 与实际变化；只读侧边详情展示完整有序键值和原文。全部／有变化／需核对统计来自完整授权结果，问题不伪造归属。
- 保存目标、追加／更新字段和独立文件明确；持久回执刷新可读。未知保存结果锁定原请求及幂等键对账，明确冲突保留目标并重新取得 CAS 修订。断线保留已确认结果。
- 助手在原会话核对本任务全部有效批次，切换批次保留各自选择；局部修订替代旧候选，固定范围及背景权限沿用原服务端检查。
- 结果、草稿、版本来源统一展示可证明的原始文件、位置和实际处理步骤；扩写始终表示模型生成及参考关系。未精修行不会继承其他行的精修步骤。不可访问来源名称和正文隐藏，历史缺失不推测。

| 现有公开入口 | 处置 |
| --- | --- |
| `POST processing-inputs` | reused：可选搜索、既有 Metadata 条件、已选视图、匹配 ID 及来源摘要 |
| `GET processing-runs/:runId` | reused：可选 `view` 的分页差异、完整统计、窄采用回执；默认读取兼容 |
| `GET processing-runs` | reused：补来源名称、操作者 |
| processing 提交、cancel/retry/accept | reused：写协议、CAS、幂等保持 |
| assistant session candidates | reused：在有效任务范围上提供同类分页核对，读取后重核对修订 |
| 草稿、版本 provenance 列表／详情 | reused：当前页真实来源展示 |

无新增公开路由、数据表、迁移、模型框架或处理策略。冻结原型与 frontend-v1 未修改。新展示逻辑位于 `src/processing/presentation.ts`、`provenance.ts`；请求内批量缓存及最多 32 层追溯，正文不全量传给浏览器。

## 自动验证

所有持久化测试使用独立测试数据库／桶与可控模型。浏览器使用现有 Playwright、单 worker，容器最多 1 CPU、2 GiB；未开展额外多人压测或长时间稳定性测试。

| 验证入口 | 实际结果与覆盖 |
| --- | --- |
| 跨页选择 red/green | 旧页面第 2 页选择丢失第 1 页记录，20≠21；修复后完整 21 条提交通过 |
| 输入过滤／来源 red/green | 旧公开接口拒绝新可选过滤参数；修复后同范围筛选、选择和来源通过 |
| `tests/integration/processing-runs.test.ts` | 13 passed；输入筛选、字段保护、缺失恢复、幂等、容量、来源草稿冲突、发布来源及不可访问原件 |
| `tests/integration/project-assistant.test.ts` 针对性选择 | 4 passed；多批有效候选、局部替代、停止、固定范围、背景与字段保护。其余 112 项未重跑 |
| `e2e/processing-workspace.spec.ts`、受影响 processing／project-assistant 用例 | 合计 10 passed；跨页与隐藏选择、gbRisk 直接差异、480px 与键盘焦点、网络／HTTP 500 未知副作用同键恢复、409 新修订、真实回执刷新、原会话多批选择、缺失重试、状态请求中断恢复 |

精修来源公开链路：3 条参考生成 7 条 → 只精修 1 条 Metadata → 清洗 7 条 → 保存新草稿 → 发布 → 查询来源。被精修行有扩写／改写／清洗，其余行只有扩写／清洗；相同输入参考不会重复列处理步骤。归档原始文件后，公开 provenance 不泄漏其名称。来源身份与原期望输出保持。

执行入口为仓库现有 Vitest／Playwright 配置，隔离浏览器临时配置不提交。完整原始日志在执行端 `.scratch/assistant-optimization/opt11-*.log`，不进入源码；其中 `processing-final`、`assistant-http`、`browser-final`、`browser-offline` 分别记录上述最终结果。正式类型、lint、构建、文档及固定环境结果见下文。

- 根目录与 frontend-v3 类型检查通过；受影响文件 ESLint 零错误，保留 2 个原有草稿 Hook 警告及 1 个共享静态文案的开发热更新警告。
- 生产模式 Vite 构建及 `tsc -p tsconfig.server.json` 通过，使用现有依赖，构建产物与配置不提交。
- `npm run docs:check`、`git diff --check` 通过；本次 5 份 Markdown 的相对文件链接、表格列数和围栏检查通过。没有新增 JSON 示例或修改 Mermaid／主业务流程。

## Standards

独立审阅发现：采用回执投影过宽、问题文案映射重复、同一输入追溯重复步骤。已分别改为窄 DTO 并去重、共享问题文案、按输入身份去重请求内追溯。针对性复查未留下 Standards 问题或明显权限风险。

## Spec

独立审阅发现：助手单运行外链不能代表任务有效成果；HTTP 500 被当成明确拒绝；第三项 Metadata 差异不直观；精修历史缺失及未选中行误显示精修步骤。已改为原会话任务预览、明确拒绝白名单与未知结果冻结、行内真实差异、按真实输入关系及选中身份追溯。复查确认以上均闭环，无未解决 P0/P1/P2。

## 限制与 Owner 验收

本轮验证交互、结构、真实持久化和权限边界；不评价既有 200 条的语义质量，也未重跑该模型任务。Owner 原会话、资料、77 个运行、18 个采用回执保留。旧关系缺少证据时只能显示可证部分。自动测试与现场只读检查不代表 Owner 接受；人工验收仍 pending。

## 固定环境与现场复验

- 应用实现提交 `b3d1822c06f82df16aa31ec8f1ceb135eab584c6`；现场发现空筛选出现孤立 0，补修 `f8e3579c1c517abad9f4d486cec96be3e05cef01`，补修 ESLint 与生产构建通过。最终 Web、ordinary Worker、model Worker 均为 `evalbase-agent-checkpoint:f8e3579c1c51`，应用 `GIT_SHA` 为后者。后续收口提交仅记录文档和截图，无需重建应用。
- `/health/ready` 返回 200、PostgreSQL/MinIO 均 ok、完整 SHA 匹配。前端 index 及全部入口 JS/CSS 返回 200。数据库与对象存储容器保留原实例，均已运行 5 天；未修改环境凭据或卷。
- 更新前后均为 1 项目、2 账号、29 会话、77 运行、18 采用回执、0 活跃任务。未创建长期测试项目或账号，未采用／发布用户待确认的 200 条成果。
- Computer Use 在现有用户浏览器通过 SSH 隧道访问真实 4217：现有 200 条改写结果的 Metadata／新增 gbRisk 直接可见，真实来源仍为 ChineseSafe 原序号；行详情 Enter 打开、Escape 关闭后焦点恢复；需核对 0 的筛选空态可返回全部；任务列表有来源、发起人、时间。
- 现有 100 条资料配置页现场验证第 1 页选 1 条＋第 2 页勾选本页＝21 条；无匹配时显示 21 条隐藏选择，清除条件不丢选择。未提交处理；核对后清空临时选择。原助手会话展示 200 条当前有效候选、旧确认过期仍被拦截，未发送提示或确认采用。
- 1440px 实际双栏，右侧设置位置约 x=960、宽 440px；480px 设置在记录表之后，页宽 465px，没有整页横向溢出。窄窗口详情宽 480px；检查后恢复浏览器默认尺寸。

截图：[配置桌面](evidence/opt11-config-1440.jpg)、[配置窄屏](evidence/opt11-config-480.jpg)、[真实结果及来源](evidence/opt11-results-1440.jpg)。入口为 `http://127.0.0.1:4217/`；继续使用现有管理员与编辑账号进行同一次 Owner checkpoint。
