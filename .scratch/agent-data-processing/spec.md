# 筛选选取与模型助手实施规格

Status: ready-for-agent
Implementation: ready-for-owner-checkpoint

2026-10-04。Owner 在当前持续目标中授权完整研究、文档、审查、实现与测试，范围包含选取原型与模型助手；无需每张 Ticket 再请求开工。智能体免原型，UI 直接复用 frontend-v1。

## 1. 基线与权威

- 代码 main/origin/main 已核对为 `9f8d7f4`；沿用用户当前原型/研究基线 `96b1868` 创建 `codex/agent-data-processing`。
- 服务器工作区 `/home/bistu/EvalBase/.worktrees/agent-data-processing`；原型工作区、正式部署、其他项目保留。
- [本轮 PRD](../../docs/PRD-data-selection-and-assistant.md) > [CONTEXT](../../CONTEXT.md) > [实施架构](../../docs/architecture/data-selection-and-assistant.md) > 本规格与 Ticket。
- [测试计划](../../docs/test-plan-data-selection-and-assistant.md)和[研究](../../docs/research/project-agent-framework-and-architecture-2026-10-04.md)提供证据；v1/v2 未覆盖部分继承已有合同。
- 本轮明确覆盖旧文档的“原型外不新增助手”“无选取/模型处理”限制；采用新 PRD 的窄范围，不恢复所有历史后台 API。

## 2. 功能 Ticket 与授权

| Ticket | 完整交付 | 依赖 | Implementation | 实现/证据 |
| --- | --- | --- | --- | --- |
| [SEL-01](issues/01-selection.md) | 固定筛选、抽取、调整、入稿、发布溯源与正式 UI | 无 | ready-for-owner-checkpoint | 算法、HTTP 集成及受影响草稿回归通过；固定预览、入稿与发布来源已实测 |
| [AI-02](issues/02-model-processing.md) | 模型连接、原件整理、三类后台处理、预览/接受与来源 | SEL-01 共享选择/应用边界 | ready-for-owner-checkpoint | 连接、后整理、三类处理/接受、真实 Worker、删除竞态和来源检查通过 |
| [AI-03](issues/03-project-assistant.md) | 自然语言业务工具、持久会话/确认、完整跨流程测试 | AI-02 | ready-for-owner-checkpoint | 助手公共接口 8 项、浏览器、真实 Qwen 和独立复审通过；统一 Owner checkpoint 待人工验收 |

三张功能 Ticket 属于本次整体授权，自动化验证与复审后连续推进；一个最终人工 checkpoint，不以中间完成为由停工或要求重复授权。完成依然要求全部 PRD 行为和测试证据。合并 main、GitHub 推送、tag、正式部署不在本次授权内。

## 3. 执行规则

使用 implement + ponytail full，沿用 TDD、受影响公共接口验证和 Standards/Spec 独立审阅。本轮测试 seam 为 PRD 的 HTTP/持久化/Browser/CSV/Deployment，以及确定算法和模型协议边界；用户已授权自行制定测试。

审阅基线固定为当前功能起点 `96b1868`，中间 Ticket 可记录自己的代码起点；不重复询问已由本轮确定的范围。涉及持久化/权限/发布/删除执行对应必要故障和竞争检查。

新 UI 对照 Ticket parity 表；frontend-v1 无 diff，筛选原型只读。功能完成后记录提交及测试；尚未证明的要求保留未完成。

## 4. 资源与验收

- 专属命名 `evalbase-agent-test` 与 `evalbase-agent-owner-checkpoint`，专属网络、卷、库和桶。只用空闲 loopback 端口。
- Owner 数据仅一个“模型与选取验收项目”、管理员和编辑两账号；自动测试身份在独立库。
- 先做 2/3 会话受控测试，不进行此前取消的 5/10 人负载、两小时稳定性测试。
- 最终 HEAD 的健康、前端构建、请求与截图一致；交付隧道、账号和简短验收步骤。用户通过后才释放该环境并记为人工验收通过。

## Comments

- 2026-10-04：已重新核对远端 main、原型/研究分支、运行容器与资源；已创建独立工作区。现有代码没有该智能体/固定预览能力。准备文档和首个垂直红测；全部功能尚未交付。

## 最终交接

实现、必要回归和独立复审已完成，统一记录见 [验证与交接](verification.md)。历史 Comments 保留当时状态；当前状态以上表和最终交接为准。Owner 人工验收 pending，运行环境固定提交由健康检查和最终交付消息标识。
