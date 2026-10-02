# 性能发现修复的短场景复测

范围见 [规格](spec.md)；结果见 [修复报告](../../docs/research/performance-repair-2026-10-03.md)。仅限专属 `evalbase-performance-repair` Compose，不能改连接串指向正式/Owner 库。测试源从仓库 bind mount 读取，Node 24.6.0；镜像内已有依赖，不安装新包。

## 执行

1. 核对正式与 Owner 健康、主机余量和精确资源名，启动 `docker compose -f .scratch/performance-repair/compose.test.yaml up -d`，执行源码迁移。
2. `git archive 58d997ca02dc110efc77b9263d4de2d2d22c1a79 src package.json tsconfig.server.json` 解压到本目录 `baseline/`。这是只读自动化基线副本，不纳入提交。
3. 保存证据到 `local-acceptance-evidence/performance-repair-2026-10-03/`，启动 `monitor.py`。STOP 不得删除或覆盖；每次请求发送前检查 STOP，监测停止专属 test 容器。
4. 在 test 内设置 `VITEST=true`，运行 `node node_modules/tsx/dist/cli.mjs .scratch/performance-repair/profile.ts baseline <attempt>` / `optimized <attempt>`。按 variant 动态加载归档/当前应用及迁移，在各自独立 schema 准备相同万条 legacy/Checkpoint 数据；每种 CSV 测三组冷/暖缓存。`wide-query.json` 保存原分页查询，用于同连接 JIT on/off 与原查询计划比较；实际路由耗时在 requests 中。
5. 在 test 内顺序运行 `node node_modules/tsx/dist/cli.mjs .scratch/performance-repair/bench.ts baseline <attempt>` / `optimized <attempt>`，不与构建或其他测试并行。各自迁移独立 schema，使用实际账号注册、邀请与会话，三个独立账号为管理员/编辑/查看。采集真实 loopback HTTP：万条分页/字段保存各三次、两种 CSV 各三组冷/暖缓存，2/3 账号下各一次 100 MB 规范化发布及首次/重复导出、三次双万条发布与第三账号读取。夹具 SQL 准备、ANALYZE 不计入请求耗时。仅补万条采样时在末尾加 `normal-only`，不重复大字节场景。
6. `<attempt>` 是新的证据子目录名；已存在的结果禁止覆盖。对应启动 `monitor.py <attempt>`，完成后在该子目录写入 monitor-finish；STOP 始终检查/写入根证据目录，不能靠更换 attempt 绕过。原始初轮执行完后运行 `analyze.py`；补测按相同 id/run/suffix/cache 对照 SHA-256。资源证据保留 memory.stat，以区分页缓存和匿名内存。

只测 2/3 账号的短场景，不做 5/10 人、两小时稳定运行、主动断线或重启恢复。保护条件：主机可用内存低于 8 GiB、磁盘余量低于 20 GiB、OOM/容器退出/重启/健康异常、共享正式/Owner 健康连续失败、专属容器 memory.current 连续约 60 秒超过预算 90%、监测失败或 30 分钟测试期限。预算 PostgreSQL 2 GiB、MinIO 1 GiB、test 3 GiB，禁止换成无限内存来掩盖问题。

## 证据与回收

保留首次环境失败、上传 RED、取消处理未完成的尝试、GREEN、原始查询计划、请求 JSONL、资源 JSONL 和最终哈希，不把未执行场景算通过。基线与优化均无错误；基线运行后给读者 Promise 增加即时错误捕获，复测后加严初始化/诊断的 STOP 检查；未改成功路径的数据/节奏，但不声称两次执行脚本逐字相同。聚合重操作 ms 包括等待读者结束；原始 requests 中的 ms 才是单个真实 HTTP 的时间。

历史首轮 profile-baseline 在分页/迁移优化前执行，profile-optimized 在优化后执行，使用同一夹具；当时上传修复已应用，但诊断不测试上传。首版 profile 的 variant 只命名输出，现已修正为动态源码与独立迁移，避免在修复源码上重跑出伪基线。历史 24 项哈希及原始一冷两暖采样保持不变；第一次追加的 review-retest 在旧环境触发 STOP，最终三冷三暖补测另存下述全新环境。不要把补测回填到初轮原始文件。

追加 profile 诊断后，原自动化环境的页缓存触发持续 90% 保护；STOP 保存于原证据根，不能续跑。封存并释放原专属 Compose 后，仅用 `compose.review-test.yaml` 的全新 `evalbase-performance-repair-review` 环境补万条采样，预算不变。它有独立数据库 `evalbase_performance_repair_review`、桶 `evalbase-performance-repair-review-tests` 和卷；脚本仅允许这两套明确的数据库/桶组合。补测证据另存 `local-acceptance-evidence/performance-repair-review-2026-10-03/normal-retest/`，启动 `monitor.py normal-retest review`，运行 profile 两种 variant 与 bench 两种 variant 的 `normal-retest normal-only` 参数。该环境也有独立根 STOP；旧 STOP 从未删除或清零。

必要校验包含后端单元、当前上传/版本/草稿/Checkpoint/稀疏写入及回收删除集成、typecheck/lint/编译与 docs:check；旧删除测试的退役登录失败与基线逐项对照，不恢复旧接口。最终双轴复审后本地提交，在固定 HEAD 更新既有 Owner Web/Worker，保留既有项目、账号及数据，五账号授权例外见 [规格](spec.md)。封存证据后分别用 `docker compose -f .scratch/performance-repair/compose.test.yaml down --volumes` 和 `docker compose -f .scratch/performance-repair/compose.review-test.yaml down --volumes` 回收两个明确命名的自动化项目；不使用全局 prune。
