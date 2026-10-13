# 助手重试预算 P1：合并前修复与验证

## 授权与固定版本

- 2026-10-14 Owner 明确授权：修复整合审阅发现的 P1，更新同一 4217 并定向验证，通过后合入 main、推送 GitHub；保留现有验收数据，精简流程。
- 整合审阅基线 `cea1320050b38f9fab188af3f7b9bdeae86ebc30`；修复代码 `66f8b2d055e9af03e46ce4ea8b1dd373400efbbe`。范围来自 [OPT-18](issues/18-processing-recovery-and-operation-settings.md) 已有手动重试预算合同，不新增产品范围、接口或数据表。
- 本轮合并准备覆盖 `codex/assistant-optimization`。原 main / origin/main 为 `9f8d7f46255aab21ee8eee3916fcc1e18b063877`，是该分支祖先；其他独立原型、调研及历史分支保持原状。

## 修复

助手会话的重试入口过去仅按失败状态或缺额重新入队，未检查本轮持久模型预算。现在在原 job → session 锁序事务内，复用 `getProcessingRun` 的权限与来源检查及 `processingRecovery.canRetry`，只入队仍可恢复的运行；全部不可恢复时返回 `409 processing_retry_unavailable`。不重置批次调用次数、起始时间或已保存结果。

前端复用现有 status API 与任务卡查询缓存，按所有关联运行的恢复能力显示“重试未完成步骤”。耗尽时保留已有结果及处理任务恢复链接。助手回复失败的独立回合重试仍沿用原路径；不会为此重新生成已完成的数据。界面组件与样式保持 frontend-v1 donor 风格。

## 定向验证与审阅

- 新公共 HTTP 回归先 RED：耗尽任务应拒绝，旧实现却返回 200；修复后 GREEN。覆盖调用次数耗尽、时间耗尽、provider 拒绝、有剩余预算、旧 v5、多运行混合，以及候选和原草稿保留。
- 受影响 `assistant-tasks.test.ts` 全部 22 项通过，包括独立回复重试、后台继续、停止围栏、来源删除和回执恢复。使用隔离测试数据库/对象桶和可控模型，没有向 Owner 环境提交生成任务。
- 三个新增浏览器场景通过：不可重试、有预算、最新运行耗尽但另一运行仍可重试。原助手回复失败兼容场景定向补跑通过，合计四个不同场景。旧用例的过时文案断言及硬编码截图目录改为当前文案和 Playwright 输出路径；没有为验证修改对应业务行为。
- 服务端/前端类型检查、受影响代码 lint、格式检查、服务端编译、diff 检查及固定代码正式 Docker 构建通过。初次浏览器构建/截图目录存在旧权限问题，改用独立临时输出；初次 Docker 命令的 CPU 参数不被 legacy builder 支持，按其本机帮助改为一核 quota 后固定构建通过。
- 原整合 Standards / Spec 审阅结果继续有效；两轴独立定向复审本次修复，均无剩余 P0/P1。只检查修复及直接受影响路径，未重复全量套件或整分支审阅。

## 4217 与数据保留

- Web 镜像 `evalbase-agent-checkpoint:66f8b2d055e9`，镜像 revision、运行环境、`/health` 和 `/health/ready` 均确认完整修复 SHA。PostgreSQL / MinIO 依赖为 ok；本机直连 4217 就绪接口返回 200、同一 SHA。
- 沿用 `evalbase-agent-owner-checkpoint`、数据库 `agent_owner`、bucket `agent-owner-checkpoint`。切换前活动处理作业/助手回合为 0，保存完整数据库备份，仅重建 Web。Worker、model-worker、PostgreSQL、MinIO 容器身份及存储挂载保持不变；两项 Worker 仍为此前 `4af93adaeda7609e3177fe2013e4091d6320acdc`，本次修复不涉及 Worker 执行代码。
- 切换前后 16 张核心表的行数与完整行内容指纹相同：账号 2、项目 2、文件 18、测试集 6、版本 8、草稿 17、草稿记录 1548、处理任务 62、运行 82、批次 784、采用回执 19、会话 14、助手回合 107；其余成员、集合、提案表也一致。备份、指纹及截图保留在服务器 `.scratch/assistant-optimization/p1-retry-*`，不提交 Owner 数据到 GitHub。
- 真实 4217 浏览器：正常登录，数据处理列表和现有助手会话均 200/可见；当前待审核会话的两项运行均不可重试，界面不显示重试按钮，输入保持，无 JavaScript 错误。只登录、读取和登出，没有触发重试、生成、采用或发布。

## 证据与交付边界

执行日志：`p1-retry-red.log`、`p1-retry-green.log`、`p1-retry-integration.log`、`p1-retry-static.log`、`p1-retry-final-static.log`、`p1-retry-browser-final.log`、`p1-retry-reply-recheck.log`、`p1-retry-fixed-build-final.log`、`p1-retry-checkpoint-cutover.log`、`p1-retry-live-browser.log`。服务器数据备份为 `p1-retry-owner-before-66f8b2d055e9.dump`，仅本地保存。

本记录的后续文档提交不改变上述固定运行代码；合并时核对 main 与该代码提交在 `src/`、`frontend-v3/`、构建配置及锁文件上无差异。GitHub 正常推送使用 `/home/bistu/.ssh/id_ed25519_github_evalbase` 并显式指定 `IdentitiesOnly=yes`；不强推、不新建 tag、不正式部署。原 Owner 人工验收状态仍 pending，本轮授权允许先合并与推送，不将其改写为验收通过。
