# 实施验证与验收交接

2026-10-04。分支 `codex/agent-data-processing`，基线 `96b1868`。本轮不合并 main、不推送 GitHub、不正式部署。Owner 人工验收待完成。

## 已完成的检查

- 干净安装的构建镜像：全量单元测试与本轮六组受影响集成测试，28 个文件、165 项通过。另有既有草稿和原件集成回归证据。
- root 类型检查、受影响文件 lint、正式前端类型检查、构建通过。
- 浏览器自动检查覆盖筛选、连接、后整理、处理与助手；真实浏览器补充检查请求格式、后整理保存、改写、扩充、人工选择、入稿、确认发布和来源展示。来源序号修复另由来源页语义测试和处理集成验证。
- 真实 Qwen：普通回答、工具调用后回填结果、结构化改写/扩充和 SDK 流式协议探针通过。产品当前采用非流式短回合，流式探针不等于产品已经提供流式回复。
- Standards/Spec 独立复审发现的问题已修复；最后单独复核了确认恢复的租约/修订约束与来源序号约定，没有未解决的 P0/P1。

最初六项离线 CLI 测试在祖先目录挂载依赖的测试容器失败，原因是子进程寻找当前目录 `node_modules/tsx`。在完成干净 `npm ci` 的构建镜像复跑后，包含这些测试的 165 项全部通过；没有为测试环境改动产品行为。

## 需求证据索引

| 测试计划编号 | 对应证据 |
| --- | --- |
| SEL-1–6 | `tests/unit/data-selection.test.ts`、`tests/integration/data-selection.test.ts`；`frontend-v3/e2e/data-selection.spec.ts`；真实浏览器条件失效、固定预览与确认加入 |
| CONN-1–2 | `tests/integration/model-connection.test.ts`、`frontend-v3/e2e/model-connection.spec.ts`；真实已保存连接调用 |
| RAW-1–2 | `tests/integration/raw-material-mapping.test.ts`、既有 material-browser 回归、`frontend-v3/e2e/raw-material-mapping.spec.ts`；真实原件后整理 |
| RUN-1–3 | `tests/unit/processing-protocol.test.ts`、`tests/integration/processing-runs.test.ts`；真实独立 Worker 与 Qwen 改写/扩充 |
| APPLY-1–2 | processing-runs、project-assistant 和 v2-collaboration 集成；真实确认采用、发布后 11 条记录 |
| TRACE-1 | processing-runs 的接受/发布/来源断言；真实父版本 v1 → v2 的新增、处理归属和选取历史；`frontend-v3/e2e/provenance.spec.ts` |
| DELETE-1 | processing-runs 的回收/删除与迟到写入场景；project-assistant 的关联正文清理、无关会话保留和撤权场景 |
| AGENT-1–3 | `tests/integration/project-assistant.test.ts` 七项；`frontend-v3/e2e/project-assistant.spec.ts`；真实查询、创建草稿和点击发布确认 |
| MODEL-1 | 少量合成兼容探针及真实三条改写、一条输入生成三条扩充；输出有语义偏差时人工排除 |
| UI-1 | 五组新界面浏览器语义/窄屏检查与来源页回归；真实 Computer Use 截图；donor 与冻结原型保持只读 |
| PERF-1 | 下述受控会话检查；不作为最大容量结论 |
| HEALTH-1 | 固定提交镜像与健康检查、专属 Compose 项目、一个项目两个账号；具体运行 SHA 和最终状态保存在验收环境证据 |

命令、完整脱敏日志、截图及运行状态保存于此目录下的 `evidence/`，不纳入源代码提交；测试源码提供可重跑的行为证据。

## 受控会话检查

使用现有管理员/编辑账号创建 2 和 3 个会话，每会话 6 次读取；在一个输入、三个输出的扩充任务入队后立即开始。通过本机 SSH 隧道测量：

| 并发会话 | 请求数 | 错误 | 中位数 | P95 | 最大 |
| --- | --- | --- | --- | --- | --- |
| 2 | 12 | 0 | 345 ms | 420.5 ms | 474.9 ms |
| 3 | 18 | 0 | 416 ms | 487.9 ms | 562 ms |

同期一次资源采样：Web 124.3 MiB / CPU 4.16%；模型 Worker 89.38 MiB / CPU 0.57%；PostgreSQL 47.73 MiB / CPU 9.67%。这些是小样本与单次资源快照，包含隧道延迟，不证明 10 人容量或持续峰值。未运行 5/10 人压力或两小时稳定性测试。另以编辑账号完成一次草稿用途字段保存，218.8 ms，重新读取确认持久化；该编辑检查单独执行，不称作模型并发压力结果。

## 浏览器发现及修复

1. 助手与处理 POST 缺少 JSON Content-Type：补齐请求头，浏览器 mock 加入请求头断言。
2. 派生文件名中文编码错误：修复模板，并断言正式来源返回可读中文文件名。
3. 来源序号偏一：解析器从 1 开始，前端不再多加 1；派生资料遵循同一存储约定。
4. 模型回复冗余内部标识：提示词要求使用对象名称、版本标签和记录数；页面操作链接仍由真实工具回执生成。

## 运行边界与后续

- 模型输出通过结构和字段保护校验后仍需语义验收。实际扩充中“昵称”被说成“用户名”的一条未采用，其余两条经明确选择后采用。
- 未引入任意代码执行、终端、网页访问、权限管理工具或多智能体。助手不会自主确认采用或发布。
- 既有依赖审计告警不因本轮通过而消失；本轮没有顺带升级 csv-parse 等可能改变既有行为的主版本。此次测试结论仅覆盖本轮功能与受影响流程。
- 验收环境只监听服务器 loopback 4217，使用专属数据库、对象存储、网络和资源限制。用户明确通过后释放专属资源；正式服务保持原状。
