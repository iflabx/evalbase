# OPT-21 验证记录

## 范围与版本

- Ticket：[OPT-21](issues/21-assistant-bounded-recovery.md)，Owner 于 2026-10-14 单张授权开发；沿用 `codex/assistant-optimization` 和同一工作区、4217。
- 实施基线：`71fce39fd46c067636b895b31748efd422e6f7ce`；固定代码：`25c71b8351edc814bea6e62263ac5e0e1fb2f188`。
- 本张完成模型请求与现有执行恢复边界，未增加依赖、表或公开 API。Implementation completed，Owner 验收 pending；OPT-22–25 保持原状态。

## 实现

对话传输只对 429、500/502/503/504 和明确短暂网络错误恢复；一个逻辑回合共享最多 2 次额外请求及原 80 秒截止时间，遵守 Retry-After。SDK 重试保持关闭。响应先经既有 8 MiB 限制并完整读取，读取中断可在模型工具尚未执行前恢复；协议、权限、配置和应用持久化错误不作为临时网络故障重试。

截止时间、模型步数、工具数、传输尝试与等待安全指标保存到现有 task JSON。恢复先加载原预算，过期重领和手工恢复不能重置；旧没有预算的任务兼容已有 observations 的已知计数。停止/撤权复用现有 dispatcher 和 AbortSignal，发送前及事务提交前均复检。原模型/工具、自动续做、executor 和 Worker 上限不提高。

未知写入沿用原操作键和参数查实际回执，无回执时保留未知状态并停止执行。已完成处理而最后说明失败仍保留候选审核和未完成计划，不创建第二个处理运行。说明恢复成功清除旧标志；说明无额度不能阻挡自身预算合法的 Worker 恢复，后台 model_attempts 和截止时间继续累计。

UI 只在现有任务反馈区显示简短恢复提示，重试入口依据服务端能力；frontend-v1 风格保持，见 Ticket 对齐记录。

## 定向验证与复审

- 传输新增回归修复前失败，修复后 11 项传输、9 项诊断单测通过。包括共享预算、请求正文不变、401/403/确定性状态不重试、Retry-After、响应体中断、回调持久化失败不重放和请求中截止取消。
- 公开 HTTP 定向检查通过：429/503/网络暂时失败后成功、跨步骤共享额度、持续故障、停止/撤权、原回执丢响应及并发恢复、无法核实写入、完成候选后说明失败、过期/执行额度不可恢复。复用原创建/发布、权限、连续同错与 Worker 额度用例。
- Standards/Spec 最终审阅发现过期重领覆盖预算和旧 model_reply 阻挡有效恢复；两项回归修复前失败，修复后相关 7 项通过，定向复核无剩余 P0/P1。后台遗留失败模拟只在隔离测试数据库进行，成功候选与 model_attempts 保留。
- 浏览器初轮 6 项通过；修复后受影响的 5 项通过，含过期说明与合法 Worker 恢复组合。检查暂时恢复反馈、无额度入口隐藏、输入/候选保留、旧会话兼容与 860px 无整页横向溢出。
- 根与 frontend-v3 typecheck、受影响后端/测试/脚本 ESLint、差异空白检查通过。浏览器沿用既有运行库和独立临时 Vite 缓存/输出目录；旧生成目录权限失败不记作业务失败。

## 固定版本基线与 checkpoint

固定代码的 Docker 构建通过，限制 1 CPU、2 GB。复用统一入口 `scripts/assistant-baseline.ts`，串行执行 A2/A3/A9/A10，见 [可控结果](opt21-controlled-fixed.json)：4/4 合同通过。A9 已纳入本张恢复回归；可控断言的 goalCompleted 为 null，不混作模型内容完成率。

[真实 A1](opt21-after-a1-real.json) 使用配置修订 1 的 `qwen3.8-27b-un`、8 条合成记录和单次简短提示，核对来源、数量及字段通过；2 次模型请求、0 次协议纠正，总用时约 5.8 秒。运行器只读复制加密模型配置到 0600 临时文件；本次临时数据库/桶已清理，Owner 数据未用于生成测试。未执行真实 200 条、压测或服务器重启试验。

沿用 `evalbase-agent-owner-checkpoint`、`agent_owner`、`agent-owner-checkpoint` 和 `127.0.0.1:4217`；仅 Web 更新为 `evalbase-agent-checkpoint:25c71b8351ed`。`/health` 与 `/health/ready` 返回固定代码 SHA，PostgreSQL/MinIO 正常。普通 Worker/model-worker 保持 `4af93adaeda7609e3177fe2013e4091d6320acdc`，其容器以及数据库/存储容器与挂载未变。

切换前已保存权限 0600 的数据库备份；16 张业务表切换前后数量与内容指纹完全一致。保留 2 个账号、18 项数据资产、17 个草稿/1548 条记录、62 个处理任务/82 个运行、14 个助手会话/107 个回合、8 个正式版本等验收数据。

真实 1440px 浏览器读取当前处理列表和最新会话均为 200/可见，旧无诊断失败明细可展开，输入保留且 0 个页面异常；只登录/登出，未发送消息或采用成果。请求命中上述固定 4217；本机转发健康检查正常。详细切换结果见 `opt21-checkpoint-final.log`。

## Owner 简短验收

1. 在 4217 打开原会话、查看已完成候选和旧失败信息，确认输入与记录仍正常。
2. 正常查询或处理小量资料，核对结果；总结失败时，应能继续查看已完成成果。
3. 429、停止退避和额度耗尽已用隔离假模型计数验证，不需要在 Owner 环境人为改坏连接；人工验收另记。

## 证据索引

服务器与本机 `.scratch/assistant-optimization/` 保留 `opt21-transport-red.log`、`opt21-public-red-fixed.log`、`opt21-critical-final.log`、`opt21-recovery-final.log`、`opt21-review-regressions-red.log`、`opt21-review-regressions-final.log`、`opt21-review-static-final.log`、`opt21-browser-green.log`、`opt21-browser-review-final.log` 、`opt21-code-build.log`、`opt21-controlled-fixed.log`、`opt21-after-a1-real.log`、`opt21-checkpoint-final.log`。一次真实小样本不表示一般内容质量或稳定成功率。
