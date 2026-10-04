# AI-03 自然语言项目助手与整体验证

Status: ready-for-agent
Implementation: ready-for-owner-checkpoint
Blocked by: AI-02

## 范围与合同

[Spec](../spec.md)、[PRD AI-04](../../../docs/PRD-data-selection-and-assistant.md#7-ai-04-项目助手)、[架构](../../../docs/architecture/data-selection-and-assistant.md)、[测试](../../../docs/test-plan-data-selection-and-assistant.md)。包含查询、建草稿、选取、清洗/改写/扩充、查进度/预览、接受与发布工具。

## 接口与验证

- 新增当前项目会话、回合、确认与历史读取窄接口；业务工具直接复用 SEL-01/AI-02 服务。
- 会话历史和确认是服务端事实；明确身份、目标、版本、参数摘要和一次性操作 ID；SDK 工具结果日志不是提交回执。
- 先用假模型的真实工具循环在 HTTP 边界证明一次查询与拒绝越权，再完成各写操作闭环与真实端点小样本。
- 集成覆盖单回合并发、错误工具、注入文本、确认伪造/过期/重放、权限撤销、草稿竞争、中断结果核对。

## UI parity

助手入口在当前项目内；面板使用 donor 的 Sheet/Card/Input/Button，消息以普通文本和真实结果卡片展示。处理/接受卡片与页面入口共用组件，支持窄窗口、键盘、加载/错误/中断。不得引入与 frontend-v1 不同的字体、渐变、按钮体系或假进度。

## 完成要求

AGENT-1–3、PERF-1、HEALTH-1 及全需求矩阵审计有证据；完整单元、现行受影响集成与浏览器、类型/lint/构建；Standards/Spec 无 P0/P1；交付固定 HEAD 的一个项目两个账号。用户人工验收保持 pending；不合并/推送/正式部署。

## Comments

- 2026-10-04：本轮整体授权已记录，尚未实现。
- 2026-10-04：已实现工具循环、服务端会话和确认、当前权限复检、依赖清理及中断回执恢复。HTTP 集成 7 项、面板浏览器检查通过；真实 Qwen 普通回答和两步工具循环通过。固定 HEAD 的最终复验与 Owner checkpoint 仍待完成。

- 2026-10-04：本轮功能及对应自动化和独立复审已完成；真实浏览器问题已修复。统一证据见 [验证与交接](../verification.md)。三张 Ticket 共用一个最终隔离 checkpoint；Owner 人工验收 pending，不合并或推送。
