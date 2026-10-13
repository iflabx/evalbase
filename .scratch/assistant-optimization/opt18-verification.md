# OPT-18 验证记录

## 范围与版本

- 分支：`codex/assistant-optimization`，实施基线 `5a166ef23d2e9af339611981785ee3e6c6d914e1`。此前 4217 应用为 `6c1dafe011e936b96229e7c6790b44e25c432035`。
- 只实施 [OPT-18](issues/18-processing-recovery-and-operation-settings.md)。沿用同一隔离 Compose 项目，不合并、推送或正式部署；Owner 数据保持。
- 新增可空批次诊断字段，复用现有作业 counts、运行与轮次，无新增依赖/框架。

## 验证

- 公共 HTTP、真实处理器和隔离数据库/可控模型：新回归先在旧实现复现四项失败；修复后与原处理、轮次回归合计 27 项通过。包含真实 model-worker 的现有成功路径、旧 v6 配方、稳定采用身份、来源失效、冲突和幂等。
- 新配置保持旧字段范围（包含 Metadata 键约束）；清洗与扩写折叠设置、改写明确字段；字体、Card/Button/Select/Checkbox、色值和密度沿用 frontend-v1 donor。只改变本张批准的配置、错误说明和恢复入口。
- 服务端、前端类型检查以及受影响源文件 lint 通过。可控模型后端定向回归 27 项先通过；审阅修补新增基础设施/租约恢复、上一轮候选未完成标记两项通过，助手自动耗尽停止和已完成重试回执两项通过。
- 浏览器：配置、继续处理、轮次共 9 个定向场景通过（配置折叠状态缺陷修复后补跑）；新增存储不可用后的成功导航回归通过。桌面 1440px、窄窗口 480px 截图已检查，无页面横向溢出，恢复详情可键盘展开。截图在 `frontend-v3/.scratch/opt18-settings*/`，不含 Owner 数据。
- 最终固定提交构建、4217 健康和数据保持结果在切换后补记。

## 审阅与交付

Standards / Spec 两轴独立审阅完成；固定审阅基线为 `5a166ef`，初次差异指纹 `7cb93d8818b9928bd26f60aee1e8db888bd46b71d5b2b2f7c251a49828a5ea9b`。发现并修复：

1. 基础设施异常/租约失效被误禁用恢复：继续按持久预算判断，不重置预算。
2. 浏览器存储不可用影响成功导航：清理设置失败不阻断已创建任务。
3. 旧候选再次改写失败缺少未完成标记：按最新轮输入与成功输出识别，旧值及身份保留。
4. 助手把质量提示误标成部分完成：改用执行完整性。
5. 自动完成/自动恢复可能重新提交以绕开预算：后台发现耗尽时停止后续处理并报告缺额；用户显式继续才开新轮。

只对这些发现和直接受影响路径补回归、定向复核；未重复全量审阅。Owner 人工验收待进行。

## 已知限制

历史批次未记录具体错误，不能还原为某一种模型失败；旧配方继续遵守原行为。没有进行真实大批模型调用或压力测试，可控错误回归证明恢复边界，不承诺实际模型一次成功或绝无重复。输入仍采用既有字段保护、来源、采用确认与容量边界。

## 检查命令

- `npm run typecheck`、`npm --prefix frontend-v3 run typecheck`；受影响 TS/TSX 和测试的 `eslint`。
- 隔离库：`npx vitest run tests/integration/processing-runs.test.ts tests/integration/processing-task-rounds.test.ts --exclude '.scratch/**' --maxWorkers=1`；审阅后按 `-t 'OPT18|keeps completed retries terminal'` 检查轮次/助手修补。
- 4317 隔离静态预览配合 Playwright 请求夹具：`processing-settings.spec.ts`、`processing-continuation.spec.ts`、`processing-task-rounds.spec.ts`；未在 Owner 库造测试账号或项目。
- 仅可空 `processing_batch.diagnostics` 列；隔离库迁移与旧配方读取通过。Owner 切换沿用幂等迁移并核对数据计数，旧批次诊断保持未知。
