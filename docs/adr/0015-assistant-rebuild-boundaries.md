# 从当前业务基线独立重建助手运行时

- Status: Accepted for rebuild design；尚未实施或切换。
- Date: 2026-10-26
- Scope: codex/assistant-rebuild；部分替代 [ADR 0014](0014-project-agent-and-processing-runtime.md) 对新助手执行路径的选择，不改变既有业务、数据保留及旧版本运行事实。

当前业务层已包含上传、协作草稿、处理轮次、采用、发布与来源等能力；退回 v0.3.1 会重新引入功能回迁和数据迁移。决定在当前 main 的独立分支重建助手运行时和工具适配，业务能力继续复用；不把旧 executeAssistantTurn、计划编译、参数修复和续步控制封装进新 Harness。

新运行时负责通用对话与工具执行，领域服务负责权限、范围、修订、确认、幂等和真实提交。旧会话与账本保留兼容读取，切换时关闭旧派发及确认消费，确保同一任务只有一个执行所有者。新检查点不能替代业务回执，旧检查点不自动转换和重放。

选择第一候选 Deep Agents JavaScript + LangGraph 进行后续兼容验证；本 ADR 不锁依赖版本、不声明已完成框架验收。拒绝长期双引擎自动回退和重新自研通用编排平台。业务 Worker 的模型调用库无需随对话运行时一并替换。

产品范围见 [PRD §7.14](../PRD-data-selection-and-assistant.md#assistant-rebuild-product)，解耦、兼容、切换和回退细节只在[重建架构](../architecture/assistant-rebuild.md)维护。现有用户授权只覆盖本次边界文档；开发、验证预算和部署按后续明确范围执行。
