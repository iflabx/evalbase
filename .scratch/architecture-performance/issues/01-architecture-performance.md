# PERF-01 架构与性能优化

Status: ready-for-human
Implementation: in-progress
Blocked by: none

## 范围

实施 [规格](../spec.md) 的验收项 1–9。Owner 已授权本轮完整开发、文档、审核、测试；基线 `cb20aea`，分支 `codex/architecture-performance`。应用与数据资源边界按规格执行。

## 首个验证切片

公共 seam 为已有健康/指标接口和任务执行结果。先补诊断并核对错误/隐私语义，再记录空队列与 10,000 条合成数据基准。Worker 退避切片以空闲领取次数降频、随后入队任务仍在 1 秒加处理时间内启动为公开运行观察；基线空闲后仅等待 50ms，预期不满足降频目标。批量化逐项使用现有上传、草稿、正式版本与 CSV 测试证明结果一致，并测量 SQL 次数。

## 必要验证

单元、受影响集成及并发/故障测试；后端/前端 typecheck、lint、正式构建、docs:check；浏览器协作/离焦保存与上传/版本路径；编译运行、健康、重启；同条件三次基准和 10 并发会话。最终 Standards/Spec 双轴审阅及发布/删除风险复查。具体命令与未执行项如实追加。

## Comments

- 2026-10-02：建立干净开发分支，文档与源码基线已核对；正式环境保持原镜像、配置和数据。规格 1–9 均待实现/验证。Owner 人工 checkpoint 尚未执行。

- 2026-10-02 开发验证：完成验收项 1–9 的实现。当前协议集成 16 文件合计 109 项通过；全量历史测试失败名称与 cb20aea 完全相同（131 项）；新增上传同键竞态先 RED 后 GREEN，取消/过期/映射变更、600 条修订第 501 条失败回滚已覆盖。
- 测量：基线/最终优化各三次，控制分页前统计信息并设置 benchmark 专属 60 秒 SQL 超时；聚合 JSON 在 results/。保留未控制统计的取消结果、主线程 CPU 阻塞回退与未稳定解决的让步实验。最终采用单个短生命周期 Node 编码线程，固定 canonical fixture 字节、SHA、错误释放队列通过；HTTP 发布期混合负载 P95 为 1460/1292/912 ms。
- 已运行命令：`docker exec evalbase-architecture-test-test-1 npx vitest run tests/unit --exclude '.scratch/**'`；受影响集成按报告分组、backend/frontend typecheck/lint；正式 Docker 构建；`npx playwright test` 16 个语义用例；独立双账号 3 个实际用例（COLLAB-07 同步约 0.83 秒，撤权、唯一发布、父版本读取）。编译线程/设置/重启及最终双轴复审仍在完成；Owner checkpoint pending。

- 最终代码闭环：Standards 0、Spec 0 未解决发现。上传同键回执重放与草稿当前页旧闭包两项 P2 均修复；真实新增记录再修改用例先 RED，再 GREEN，连同原完整协作 2 项通过（35.5 秒，同步 818 ms）。当前页判断读取完整查询键的最新缓存，不重启焦点或在线生命周期。
- 最终门禁：后端单元 21 文件/137 项通过；编码相关稀疏/共享草稿 21 项通过；切换/Checkpoint/统一读取 22 项通过；compiled 模式双账号及设置 6 项通过；前端语义 16 项通过。typecheck、受影响 lint（0 errors，既有 hook warnings）、编译构建、JSON 解析、diff check 通过。宿主 `npm run docs:check` 通过；容器内首次文档检查因宿主 Git 提交不可见而失败，未修改历史提交引用。
- 运行闭环：compiled runtime Node 24.6.0、非 root、无 src/tsx/typescript、迁移重复执行退出 0；隔离 Web/Worker 正常重启后正式版本仍可读，CSV SHA-256 不变，未认证含测试身份头仍 401。正式 evalbase 的镜像与 2026-09-30 启动时间不变。
- 测量与限制见 [结果报告](../../../docs/research/architecture-performance-optimization-2026-10-02.md)：SQL 大幅下降，10 会话延迟降低；发布混合 P95 与 RSS 的取舍、未控制 GC/冷缓存、历史 131 同集合失败均保留。Owner 人工验收 pending，Implementation 继续 in-progress。

- 实现提交 `ea4fa68`（基线 `cb20aea`）。该提交已完成双轴复审和上述自动化闭环；后续进度提交不更改应用代码。固定运行 HEAD 用独立健康证据记录，避免文档提交自引用。验收环境使用 `evalbase-architecture-checkpoint`、loopback 4217、独立数据库卷及 `evalbase-architecture-checkpoint` 桶；只含一个「架构优化验收项目」和管理员、编辑两个账号。自动化测试资源在证据封存后释放；此环境保留至 Owner 验收后释放。未合并 main、未推送 GitHub、未正式部署。
