# 2/3 账号性能验证脚本

范围以 [性能方案](../../docs/test-plan-performance.md) 为准。应用镜像固定为 `evalbase-architecture-performance:1d62240`；方案基线为 `1002c7b`。仅使用 `evalbase-performance-validation` 专属库、桶、卷、网络和 loopback 4240。账号密码通过运行时 `PERF_PASSWORD` 注入，不写结果；Compose 的数据库/存储凭据是该临时环境的合成测试凭据。

- `driver.mjs`：注册/数据准备、正确性前置、单项基线及六个混合负载档。
- `runner.py`：等待空闲观测与浏览器前置，然后运行基线及 2/3 人各三次，均预热 2 分钟、测量 20 分钟。
- `fixed.mjs`：2/3 账号分别以 2/3 动作每秒运行 180 秒，独立记录计划到达、排队与完成时间。
- `heavy.mjs`：上传、发布、字节/行/文件边界、过滤、列表规模、版本存储和合成删除；SQL 只准备专属库夹具，正式操作走现有 HTTP。
- `browser.mjs`、`browser-heavy.mjs`、`browser-list.mjs`：独立浏览器上下文、同步/冲突、重操作中的浏览探针、统一分页及保存等待。人为延迟响应的检查只用于正确性，不计入性能分位数。
- `idle.py`：10 分钟空闲和真实 Checkpoint 任务；数据库事务数包含健康与观测查询，不能称为 Worker 查询数。
- `monitor.py`：采样、20 GiB 磁盘/8 GiB 主机可用内存底线、容器内存/OOM、健康与队列进度保护；只停止本任务负载器与浏览器。
- `post-runner.py`：混合负载完成后执行固定到达、重操作及列表浏览器检查。
- `analyze.py`：原始 JSONL 聚合。快操作不足 200 次、p99 不足 1,000 次时仅列观测分位数，不作充分性判断；容量边界单次结果不冒充可靠 p95。
- `diagnose.mjs`：负载结束后，对现有分页 SQL 做有超时限制的只读 EXPLAIN，移除计划参数，并核对已缓存 CSV 的 HTTP/SQL 计数与耗时。
- `oversize-diagnose.mjs`：用原生 HTTP 单次复核 50,000,001 字节上传的响应/连接错误与可见资产数量。首轮发现 TCP 重置后，原始失败标记、日志保存在 `attempt1/`；只有确认 Web 健康、无 STOP 且缺陷已复现后，才用 `PERF_RESUME_AFTER_OVERSIZE=1` 继续容量及后续场景。已通过阶段不重跑，已确认的单文件超限不重跑；结果标记为 `completed-with-known-oversize-failure`，不能记为全通过。任何新失败仍停止后续负载。

证据保存在仓库外部跟踪的 `local-acceptance-evidence/performance-validation/` 中，封存后方可移除专属 Compose 资源。正式实例与 Owner checkpoint 不回收。5/10 人、两小时稳定运行、断线、依赖故障及重启恢复不执行。

本轮实际结果见 [验证报告](../../docs/research/performance-validation-2026-10-02.md)：正常六轮和固定到达完成，超限上传失败；续跑剩余容量场景后触发安全 STOP。没有生成后续全部完成标记，不能把上述 `completed-with-known-oversize-failure` 的预定终态当作本轮结果。原始 STOP/失败和未执行覆盖均保留，专属环境已清理。
