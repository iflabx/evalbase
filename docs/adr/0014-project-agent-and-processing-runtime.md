# 项目助手采用有界模型循环与现有数据库作业

- Status: Accepted for implementation
- Date: 2026-10-04
- Authority: Owner 本轮授权代理研究、设计并完整实现；功能范围以新 PRD 为准，本文不代表实现完成。
- Scope: 筛选选取、模型连接、处理运行和自然语言助手。

## 决策

采用 AI SDK ToolLoopAgent 和明确的 OpenAI-compatible provider 模型对象，在现有 Fastify 内执行有界对话。耗时模型处理通过现有 PostgreSQL job/Worker，新增领取 kind 范围与模型消费者；沿用 PostgreSQL/MinIO 职责和事务发布协议。

权威状态由应用持久化：会话、固定预览/结果、当前权限、一次性确认、业务操作回执。操作回执与业务修改同事务，不能靠 SDK 日志或模型 tool_call_id 实现业务幂等。普通循环中断后明确报告并核对效果；暂不引入持久图运行时。

模型凭据采用 AES-256-GCM，以部署环境提供的主密钥加密存储；缺少主密钥不允许保存明文连接。端点由管理员维护，成员/模型不控制目的网络地址。日志不记录凭据或任意正文。

固定随机选取使用 `sha256-rank-v1`：种子和稳定来源身份决定排名，输入与规则冻结，补选仅限候选。正文仍从授权的固定解析视图读取，预览不创建第二份原件。

本轮原件保存可延后字段整理，但仍由确认动作形成可见资产，且显式标识未整理；这补充 ADR 0009，不改变确认前不可见或原件不可变。

## 后果与验证

需要新增迁移、提交回执、处理产物引用清理和生成归属；在旧数据升级、并发、重试及永久删除场景验证。LangGraph 等检查点即使后续引入，也不能取代这些业务约束。

已有发布、源数据容量与权限规则保持；新行为只在 [PRD](../PRD-data-selection-and-assistant.md) 指定范围覆盖旧合同。具体接口和恢复见 [架构](../architecture/data-selection-and-assistant.md)，证据见 [测试计划](../test-plan-data-selection-and-assistant.md)。
