# OPT-12 实施验证

日期：2026-10-11。分支 `codex/assistant-optimization`，实施基线 `e257ca127102a845a6cdc38840e0489be207f518`。Owner 验收 pending；本记录不代签人工接受。

## 已核实的行为

- 原始文件、指定版本及草稿的跨页选择、要求及页码在站内返回/浏览器返回后恢复；修订变化保留要求、阻止旧范围提交并要求重新选择。状态仅存在当前标签页内存；查看来源另开标签页，不承诺关闭浏览器或硬刷新后的恢复。
- 首页选三类已有来源，不自动选择版本、不提交任务。历史最近 100 项内搜索要求/来源、状态筛选和每页 20 项分页；保存标识来自有效真实回执，执行完成与数据检查分开表达。
- donor 表单与控件、三方式按钮、Metadata 候选、字段保护提示及表头/全部匹配选择；桌面优先数据列，窄屏设置定位。1440/1280/1024/480px 截图及无页面横向溢出断言已完成。
- 结果正文/Metadata/可见来源搜索由服务端在完整授权范围计算；工具栏、已有选择和旧内容标识在加载及临时读取失败时保留，禁用旧范围操作。权限或来源失效不以缓存恢复正文。
- 连续详情按当前范围跨页从第 20→21 条，关闭回到当前行并恢复焦点；Metadata 单项变化不重复，完整只读内容可展开。保存所选数量、目标、原幂等请求、未知响应对账和 CAS 冲突恢复保持。
- 助手共享核对保留跨页选择、多批有效范围与范围变化重置；未改规划、调度、工具权限或模型调用配方。

## 自动化命令与结果

1. 旧 4217 前端配合合成 HTTP 响应复现配置丢失 RED；新预览 GREEN。证据日志 `opt12-config-red.log` / `opt12-config-green.log`。结果读取失败边界亦先 RED 后修复。
2. 使用既有 Playwright `v1.62.1-noble` 容器、单 worker、CPU 1 / 内存 1GiB，指向临时前端预览 4192：`processing-followup`、`processing-workspace`、`processing` 及 `project-assistant` 三项直接受影响用例，共 **19 项通过**。命令及初次旧文案断言失败、修正后的实际结果保存于 `opt12-browser-followup.log` / `opt12-browser-final.log`。未在 Owner 数据上运行处理或采用写入。
3. 独立自动化测试网络/库/桶内 `vitest run tests/integration/processing-runs.test.ts`，已通过 **13 项**，覆盖完整范围搜索/计数、来源/字段保护、保存回放、冲突、恢复与后台执行。模型使用测试桩，非真实 200/10,000 条调用。
4. root/frontend `typecheck` 通过；四个直接相关 unit 文件 **26 项通过**（processing-review / processing-protocol / assistant-review / assistant-candidates）；正式前端构建通过。受影响文件 lint 0 错误，既有 processing-review 的 react-refresh 导出警告保留。额外全前端 lint 被既有未跟踪 `opt11.playwright.config.ts` 的 4 项格式错误阻断；该历史临时文件不在本轮范围，已回到受影响文件验证。
5. 复审补修后 **4 项定向浏览器复验通过**（包含 2 项新增），覆盖同 key 撤权、来源失效不展示缓存投影、保留用户要求与助手范围。Spec 发现已预热筛选的缓存切换路径，旧助手代码再现 RED，按当前 scope 清理 inactive 读取缓存；切换与原地重试恢复的 **2 项最终复验通过**，日志 `opt12-browser-cache-red.log` / `opt12-browser-cache-final.log`。手动结果失权后无筛选入口，重试重新成功读取后恢复；助手两种筛选均预热后的 403 切回即时无旧正文。配置页同类输入缓存亦先 RED 后修复，1 项最终 GREEN（`opt12-browser-input-cache-red.log` / `opt12-browser-input-cache-green.log`），账号/项目/来源的 inactive 输入读取缓存清除，用户要求保留。

测试使用临时独立 PostgreSQL 库及 `evalbase-opt12-test` 桶，容器限制资源；既有 Owner 项目、账号、会话、资料、历史结果不变。此轮不是性能或稳定性测试，未运行广泛全仓测试、多人压测、重启持久化或真实长任务。

## 验收范围与限制

R12-1–12 的开发证据由上述针对性公开浏览器/HTTP 检查及最终源代码审阅组成；不是每个矩阵排列组合均逐项浏览器运行。账号切换/登出沿用现有会话导航清空内存，账号/项目/来源键经源代码审阅；配置缓存不含正文。历史真实保存覆盖只显示“有保存记录”，不估算去重数量。Metadata 字段候选最多 100 个，其他合法名称可手动输入。最终内容语义仍由用户审核。

## Standards / Spec 审阅

依照 code-review 两项独立只读审阅，发现的撤权缓存 P1 已修复：同查询错误先阻止所有正文投影，清空上次快照及当前 scope 的 inactive 读取缓存。当前失败查询保留供原地重试，配置输入、其他项目/运行及写入幂等状态不变。

- Standards：修复后复核通过，无未解决 P0/P1。
- Spec：修复后复核通过，无新阻断项；最终缓存切换/重试恢复 2 项及输入缓存 1 项 GREEN 已记录；最后配置页同类收口已再次通过两个审阅轴。

## 4217 交付

应用提交 **`7d9c8e5c110abf1bafccd94d094f361b7fb3c2fe`**（主体 `045be4c`，最后输入缓存收口 `7d9c8e5`）。镜像仅由该固定提交的 `git archive` 构建，CPU 1 / 内存 2GiB；Web、Worker、Model Worker 均使用 `evalbase-agent-checkpoint:7d9c8e5c110a` 和相同 GIT_SHA。更新前无活动任务，仅重建三项应用服务，PostgreSQL/MinIO 容器 ID 不变；无新增迁移。

- 服务器 `/health`、`/health/ready` 通过；本机隧道直连同样返回上述 SHA，PostgreSQL/MinIO 均 `ok`。本机 PowerShell 默认代理曾返回 502，`curl --noproxy '*'` 和实际浏览器直连成功，隧道保持。
- Computer Use 在新标签页实际核对 100个问题_new.csv：Metadata 可见，三处理方式、字段保护及选取工具栏正常；第 1/2 页各选一条，填写要求，返回任务再浏览器返回后仍为第 2 页、已选 2 条、要求不丢失；查看来源 `target=_blank`。未重载用户原标签页。
- 实际任务表共 77 项、4 页，明确最近 100 项范围；新建处理菜单有原始文件、测试集版本、测试集草稿，取消后不建任务。已有 20 条结果显示“已完成 · 已产生 20 / 20 条结果”；只读详情的下一条/关闭、完整 Metadata、来源及结果搜索的加载、无匹配、清除后恢复均已核对。
- 现场核对未提交处理、采用、发布或模型调用，临时界面输入已清空；Owner 仍 **1 项目、2 账号、0 活动任务**。验收首页保留在侧栏新标签页。
- 本轮临时预览 4192 已停止，独立 `evalbase-opt12-test` 桶及 146 个合成对象已删除，临时测试容器自动移除，未部署的初次候选镜像已删除。保留既有验收环境、测试基础服务和审查证据；Owner 通过后再按约定释放 checkpoint 资源。

实际配置截图：本机 `D:/AgentBench_v2/.scratch/assistant-optimization/opt12-checkpoint-config.jpg`（副本与日志保留于本记录目录，未提交二进制图到 Git）。本轮不合并 main、不推送 GitHub、不打 tag、不正式部署。
