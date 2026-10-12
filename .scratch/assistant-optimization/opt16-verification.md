# OPT-16 实施与验证记录

- 日期：2026-10-13。
- Ticket：[OPT-16](issues/16-processing-deduplication-and-list-ux.md)。
- Implementation：completed；Owner 验收：pending。
- 应用分支：`codex/assistant-optimization`；基线：`c189f62956c3cc4e8e3a23d8d2be05b8cd1111fe`。
- 固定应用提交：`e512a71c5529dbe9b4bde0cd1253b25cae67d1e8`。
- 仅更新原 4217 隔离 checkpoint；未合并 main、推送或正式部署。OPT-17 保持未开发。

## 实施内容

1. 复用一套确定性完整内容比较：问题、期望输出、Metadata 键值一致才判定完全重复，Metadata 顺序不影响比较。同题但其他字段不同仅提示相似，不自动删除。
2. 新扩充任务跨批排除重复、空问题及来源/目标草稿中的已有内容；只补缺口，每批最多三次模型调用，共用 60 秒预算，重试及恢复继续使用已记录的预算。已有有效结果保留；用现有继续处理机制显式补齐剩余数量。
3. 已有结果提供“去重”和“恢复排除”。仅在用户确认保存回原草稿时，按可追溯的明确清单移除原草稿重复行；增改删与幂等凭据同事务提交。普通取消勾选及另存不会删除原草稿行。
4. 来源默认按文件汇总，展开显示任务参考范围和已有处理过程；无法证明逐条引用时不冒充精确引用，历史缺失数量不编造。
5. 原始数据、测试集、处理任务列表缩短工具栏、表格与页脚间距；零条不显示分页，单页不显示无效翻页按钮。处理状态筛选收敛为“全部状态／进行中／已完成／需处理／已取消”，行内保留具体执行和保存状态。

样式沿用 frontend-v1 的颜色、字体、按钮、表格、弹窗及卡片组件语言；frontend-v1 与冻结原型均只读。保留权限、字段保护、修订冲突、来源可访问性和原草稿保存边界。

## 实际验证

| 检查 | 结果 | 范围与证据 |
| --- | --- | --- |
| 服务端单元/集成 | 36 passed | 20 项单元、16 项 processing-runs 集成；可控 HTTP 模型响应，隔离临时数据库 |
| 浏览器回归 | 13 项最终通过 | loading-experience 6 项、processing-continuation 5 项、processing-deduplication 2 项；单 worker |
| 类型 | passed | 根目录及 frontend-v3 TypeScript |
| 受影响 lint | 无错误 | processing-review 原有 react-refresh 导出警告 1 项，未扩大清理 |
| 构建 | passed | 前端预览构建及固定提交的正式 Web/服务端 Docker 构建 |
| 文档 | passed | `npm run docs:check`；Markdown 链接/表格/围栏检查及 LF 行尾修正后 `git diff --check` |
| UI 截图 | checked | 1440、480 宽度结果页及短表任务列表；表格内部可滚动，页面无横向溢出 |
| 实时 Computer Use | checked | 4217 更新后实际账号浏览原始数据、处理列表、五类筛选和历史结果来源弹窗；原有 100 条任务参考范围按文件折叠汇总 |
| 4217 运行 | passed | Web healthy；两个 Worker 启动；健康、安装检查、HTML 与主 JS 资源返回 200 |

服务端命令：

```sh
npx vitest run --exclude '.scratch/**' tests/unit/processing-deduplication.test.ts tests/unit/processing-review.test.ts tests/unit/processing-protocol.test.ts tests/integration/processing-runs.test.ts
```

浏览器使用已安装的 Playwright 1.62.1 Chromium 容器、单 worker 和本任务 4317 预览，运行以下三个文件；确定性 API 夹具不污染 Owner 验收数据：

```text
frontend-v3/e2e/loading-experience.spec.ts
frontend-v3/e2e/processing-continuation.spec.ts
frontend-v3/e2e/processing-deduplication.spec.ts
```

定向测试覆盖：Metadata 顺序、同题异值、跨批重复、输入/目标已有内容、空问题、三次预算及恢复不重复调用、早批恢复保留后批有效结果、去重清单、保存回原草稿的修订冲突/幂等/权限、参考数量真实、跨页选中范围、来源折叠、缓存刷新及紧凑空态。

浏览器首次运行发现旧文案断言，更新为新的“任务参考范围”；新用例保存请求断言改为等待异步请求完成。对应文件全部重跑通过。最终共 13 个唯一用例通过，并非一次初始运行全部通过。完整日志集中在服务器 `.scratch/assistant-optimization/opt16-*.log`，不提交构建产物、日志或测试秘密。

没有新增真实模型大批量生成、压力测试或长时间稳定性测试。自动补齐的算法与预算由可控响应验证；真实模型生成的语义质量仍需要用户核对。

## 审阅及关闭的问题

按服务器当前流程做一次 Standards/Spec 两轴审阅，以下发现已修复并完成定向复核：

- 目标草稿空选择不能只比较空输入：读取目标全部现存内容；合并后检查 100 MB 冻结范围，避免扩大资源消耗。
- 早批恢复不能忽略后批已保存结果：预装全部有效批内容，保留已有结果标识及内容。
- 有效数量及重复数量不能依赖当前搜索结果：基于完整任务计算，并以有效数量判断剩余缺口。
- 空问题不能计入新协议扩充完成数：排除并在有限预算内补齐，旧任务协议仍按既有恢复规则处理。

## 4217 固定版本

- 三个应用服务镜像：`evalbase-agent-checkpoint:e512a71c5529`，image ID：`dae84b4cd5cd`。
- Web、Worker、Model Worker 使用同一固定代码；`/health/ready` 返回完整应用 SHA，PostgreSQL/MinIO 均 ok。
- 前端主资源：`/assets/index-C89djRQQ.js`，200；`/api/installation` 返回 `needsAdministrator: false`。
- 数据库迁移只新增 `processing_batch.model_attempts`、`model_started_at`，已在 checkpoint 确认存在。
- 切换前没有排队、运行或等待重试任务；保留原数据库、桶及账号，不重置数据。
- 切换前后数量一致：账号 2、项目 2、草稿 17、处理任务 80。本轮没有新增或清理 Owner 项目/账号。

实时浏览器对既有 `processing_96eaba1866b14de5be7ef84e57b64910` 选择全部 110 条并查看去重预览，返回 22 条多余的完全重复结果及明确原草稿移除说明；取消预览，未保存/删除原草稿，也未启动模型任务。来源弹窗实际显示 `100个问题_new.csv` 的 100 条任务参考记录，默认折叠。

## Owner 建议验收

1. 刷新 4217，核对三个列表的搜索栏、短表页脚与数据处理五类状态筛选。
2. 打开已有重复结果，选择包含重复行的结果，点击“去重”，核对保留/排除数量与“恢复排除”。保存回原草稿前检查明确的移除清单；只取消选择不会删除原数据。
3. 点击“查看来源”，核对默认按文件汇总、参考范围折叠、连续处理过程及保存入口。
4. 新建少量扩充，检查有效结果/目标数量及剩余补齐入口；不因重复自动无限调用模型。

Owner 验收完成后再更新本轮状态；此前 Ticket 的历史验收记录保持原样。
