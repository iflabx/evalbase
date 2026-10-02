# 性能测试发现的修复与复测

Owner 已授权修复 [验证报告](../../docs/research/performance-validation-2026-10-02.md) 的上传超限、分页全版正文读取和 CSV 缓存命中成本。沿用 `codex/architecture-performance`，应用代码基线 `58d997ca02dc110efc77b9263d4de2d2d22c1a79`；记录于 [PERF-01](../architecture-performance/issues/01-architecture-performance.md)。使用 implement + ponytail full。

## 必须保留

[PRD v2](../../docs/PRD-evalbase-v2.md)、[CONTEXT](../../CONTEXT.md)、[架构](../../docs/architecture/phase1a-architecture.md) 与 ADR 0005/0008/0011 的容量、身份、完整性、来源、CSV 字节和删除保护不变。版本读取继续使用统一解析器；先解析完整成员再筛选/分页，不能先分页 Checkpoint 再回放 Delta。每次请求重新授权并检查版本和依赖状态；缓存不是真源，不绕过 fail-closed。

## 验收项

1. **真实 HTTP 超限**：CSV/JSON/JSONL 的 Content-Length 与 chunked 请求超过 50,000,000 bytes 返回完整、可解析的 413；无 ECONNRESET、可见半上传或遗留 staging。合法边界、后续小请求及 Worker 自有流中止仍正确。
2. **分页成本**：保留总数、稳定序号、全部筛选/搜索、完整 filterOptions、空版本/空页、legacy/Delta/Checkpoint 与损坏成员拒绝；减少全版大正文临时物化和重复 SQL 处理。先用同连接、同数据的查询计划核对 JIT 编译成本，再选择有证据的局部优化，不修改共享服务器全局数据库配置。
3. **导出缓存**：已有正确缓存命中时避免重建全部来源、前后值和 diff。权限、当前/父依赖、证据及删除变化仍使缓存失效或拒绝；CSV 公式保护、转义、顺序及现有字节不变。命中和删除/损坏场景均需回归。
4. **重操作复测**：同条件至少三次万条正常读/保存/首次与重复导出，对比原代码及修复代码；再核对大字节和双发布期间的 2/3 独立账号轻量读取。保存原始数据、资源峰值及实际差异，不承诺未测人数或比例，不用减少容量掩盖问题。

现有 pending-uploads、版本 records、两种 CSV 与删除接口均 reused，不新增公开 API、用户设置、页面或依赖；frontend-v1 和冻结原型不改。若复测揭示大字节编码/内存仍有实际瓶颈，在同一任务内继续优化其已测路径，保持原子发布和哈希协议。

## 验证与交付

新增真实传输回归先 RED 后 GREEN；复用统一读取/筛选/导出/删除与容量测试，按实际受影响 seam 增补必要检查；后端 typecheck、受影响 lint、编译构建和 docs:check，最终 Standards/Spec 复审。应用改动涉及共享存储读取与缓存，回归须覆盖 legacy、Checkpoint、稀疏派生和删除切断；不为代码未影响的历史退役接口重复修复或扩张功能。

测试另用 `evalbase-performance-repair` 专属库、桶、卷、网络；此前 STOP 与结果原样保留，不续跑其旧环境。当前只有短场景，复测仍为 2/3 账号，不安排 5/10 人、两小时 soak、主动断线或重启恢复。沿用主机余量、OOM/健康和容器预算保护，触发则停止并如实记录。

完成后提交当前分支，在固定 HEAD 更新既有 Owner 验收环境受影响服务，核对健康与实际业务请求。Owner 数据保持现有一个项目与管理员/编辑账号，自动化夹具不进入该库。现场核对前次 Owner 明确授权五账号测试的三个临时账号仍在；本轮保留其现有数据，不将测试人数改为 2/3 误作删除这些账号的授权。以后验收默认两个账号的约定不变。保存证据后回收自动化独占资源，Owner checkpoint 保留待验收。本轮不合并 main、不推送、不正式部署。
