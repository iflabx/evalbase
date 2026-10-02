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

- 2026-10-02 Owner 授权五账号协作测试后，发现新记录的空白 Metadata 输入占位行误判为本地修改，与其他用户新增的合法空值项冲突。Owner 授权修复并制定全面性能测试方案；本次基线 `c5e791683c65730e11bfb205c50a6bf32ddbda31`，沿用当前功能分支，不改写此前验收。公共 seam 为 `mergeRecordSnapshot`、草稿浏览器自动保存/快照合并；现有 collaborative-drafts 快照、字段保存、事件与在线路由均 reused，无 API/数据库/布局变更。

| 本次草稿页对照 | 保留的字段/顺序/标签 | 状态和错误语义 |
| --- | --- | --- |
| 记录编辑区 Metadata | donor 行内键值、空白输入占位及原有操作 | 空白占位不算修改；命名空值项保留；真实竞争保留本地输入和原有解决按钮 |
| 页头自动保存状态/退出 | 原有已保存、未保存、失败、退出草稿顺序 | 未编辑字段自动采用远端；真正未确认输入和冲突仍阻止退出/发布 |

扩展性能方案见 [性能与瓶颈测试方案](../../../docs/test-plan-performance.md)。按 2026-10-02 Owner 后续指令，本轮改为 2/3 个独立用户并发负载，保留容量、重操作干扰和分层瓶颈定位，不安排 5/10 人负载、两小时稳定运行、断线和重启恢复；当前仅修改方案，不记为性能通过。此前五账号测试覆盖原有一个项目，临时增加三个账号由当次 Owner 指令授权；不能把该例外改写为以后验收的默认账号数量。

- 修复验证：`npm --prefix frontend-v3 test -- src/services/merge-draft.test.ts` 先 RED（2 个占位用例失败、3 个通过），修复后 5/5 GREEN。`draft-autosave.spec.ts` 浏览器回归 1/1，包含空占位采用远端、空值显示、离焦保存、退出等待、失败重试及原有真实输入冲突语义；宿主浏览器缺系统库，改用既有固定 Playwright 镜像。最初测试容器 network=none 导致浏览器被判离线，改用隔离 bridge 后通过，环境失败不算应用失败。受影响 typecheck/lint、构建、docs:check/diff check 与双轴复审记录在任务专属证据目录；Standards 0、Spec 0 发现。真实双账号空值冲突及固定 HEAD 健康将在提交后写入独立证据，未运行全量历史后端/容量套件，因为无服务端、存储或权限改动。本轮 Owner 验收仍 pending。

- 2026-10-03 扩展性能执行结果：应用镜像固定 `1d622405f19f19300203ba82a08f80966b3573e3`，方案基线 `1002c7b`，复用当前分支。新增脚本仅调用现有路由并准备隔离合成夹具；没有改应用/API/数据库结构。两人、三人各三轮（每轮预热 2 分钟 + 测量 20 分钟）及各 180 秒固定到达探针完成，无意外正常档失败。前置真实浏览器同步 20 次约 803–1,321 ms；Metadata 空白占位采用远端、同字段冲突保留输入、同草稿唯一发布通过。
- 本轮**未整体通过**：50,000,001 byte 上传真实 HTTP 连接重置而非 413；首轮失败/hash 保留，原生复核后只继续尚未执行的容量场景。重操作浏览器翻页最高 5.8 秒，双万条发布最高约 17.5 秒。数据库容器内存连续 12 次超过 2 GiB 的 90% 后触发 STOP，未清除 STOP；无 OOM/重启。深链/legacy/删除及列表容量等后续用例未运行，正常档部分操作样本不足 200。详见 [验证结果](../../../docs/research/performance-validation-2026-10-02.md)，不以已有周期任务成功替代未执行场景。
- 测试脚本 Standards/Spec 发现均已修正并复查，包括原生诊断入口及发送前 STOP guard；本地模拟覆盖 STOP 重复执行、子进程失败/deadline 与失败/取消/未完成聚合。应用未改，未重复应用全量套件或构建；新增工具与结果文档的语法、diff、docs:check 及封存结果记录于 `local-acceptance-evidence/performance-validation/`。正式与 Owner 环境保留，自动化专属资源封存后回收；Owner checkpoint 仍 pending，Implementation 保持 in-progress。没有合并 main、推送或正式部署。

- 2026-10-03 Owner 授权修复上述性能测试发现：基线 `58d997c`，沿用当前开发分支；范围与验收项见 [修复规格](../../performance-repair/spec.md)。pending-uploads、版本 records、两种 CSV 与删除接口均 reused；不新增 UI、API 或容量。新增真实 HTTP byte-limit 回归，先验证 50 MB + 1 的连接重置，再修复借用 HTTP 流与自有 Worker 流的失败处理。分页及 CSV 需同时保留统一解析、完整性与删除保护，随后同条件复测；原 STOP/未通过报告不改写。Owner checkpoint 仍 pending，本次授权不含合并、推送或正式部署。

- 本轮修复与复测：真实 HTTP 完整 413、分页只携带成员 ID 后读取当前页、数据库证据指纹检查后直接返回暖 CSV。统一 resolver 的 Checkpoint 引用校验物化后执行 fail-closed。原生上传 10 项（含同步自有流取消先 RED 后 GREEN）、统一读取/筛选/暖缓存 12 项、当前回收/永久删除 19 项及其他必要回归合计 208 项通过。旧删除三文件 18 failed / 2 skipped 与 `58d997c` 同集合失败，未恢复退役登录 seam。后端 typecheck、受影响 eslint、diff check 与正式 Docker 编译通过；docs:check 及固定 HEAD 交付证据独立保存。
- 本轮 Standards/Spec 五项 P2（基线诊断可复现、同步流立即中止、冷/暖样本不足、聚合 STOP 路径与账号说明）已修复并复查。万条真实 HTTP 补测三冷三暖及分页/保存各三次，两个 variant 各 38 请求无错误、36 诊断与两种 CSV 哈希一致；中位分页 227→108 ms，重复数据 CSV 724→194 ms。2/3 账号重操作无意外请求错误；100 MB 发布与内存未证明改善，缓存预算压力仍在，详见 [修复报告](../../../docs/research/performance-repair-2026-10-03.md)。
- 本轮追加诊断后原自动化 MinIO 页缓存触发持续 90% STOP，无 OOM/共享健康失败；保持标记，封存并释放专属资源后，以全新同预算环境仅补万条采样。新环境 96 个资源样本无 OOM/重启/健康错误。未重置 Owner 数据；现场核对其一个项目、原管理员/编辑及前次 Owner 明确授权五账号测试添加的三账号仍在，属于既有授权例外。本轮不新增 Owner 账号；以后默认两个账号的约定不变。所有自动化资源封存后回收，固定 HEAD 更新既有 Owner Web/Worker；人工 checkpoint pending，Implementation 继续 in-progress。本地提交 SHA、实际健康与回收清单写入独立交付证据，避免提交自引用；未合并、推送或正式部署。
