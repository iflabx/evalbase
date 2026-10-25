# EvalBase 文档导航

[项目介绍](../README.zh-CN.md) · [English overview](../README.md)

从使用角度阅读项目介绍；安装、开发和定位实现时，按下表选择入口。产品合同规定行为，实施台账和验证记录说明完成情况，两者职责不同。

## 使用与开发入口

| 我想了解什么                     | 文档                                                                    |
| -------------------------------- | ----------------------------------------------------------------------- |
| 项目做什么、有哪些功能           | [中文介绍](../README.zh-CN.md)、[English](../README.md)                 |
| 如何启动、初始化管理员、配置模型 | [启动与配置](getting-started.md)                                        |
| 如何开发正式前端                 | [frontend-v3](../frontend-v3/README.md)                                 |
| 如何贡献、选择检查、提交改动     | [中文贡献指南](../CONTRIBUTING.zh-CN.md)、[English](../CONTRIBUTING.md) |
| 如何从旧单人实例升级账号         | [账号升级运行说明](runbooks/v2-account-upgrade.md)                      |
| 如何报告安全问题                 | [安全政策](../SECURITY.zh-CN.md)                                        |

## 当前产品与架构

| 范围                               | 产品合同                                              | 技术说明                                                       |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| 账号、权限与共享草稿               | [v2 PRD](PRD-evalbase-v2.md)                          | [v2 架构](architecture/evalbase-v2-architecture.md)            |
| 选取、模型连接、数据处理和项目助手 | [处理与助手 PRD](PRD-data-selection-and-assistant.md) | [处理与助手架构](architecture/data-selection-and-assistant.md) |
| 业务术语                           | [领域词汇](../CONTEXT.md)                             | [架构决策目录](adr/)                                           |

项目助手相关的机制整理与已发现缺口见[机制整理方案](assistant-mechanism-consolidation-2026-10-22.md)和[全面审查](assistant-full-review-2026-10-23.md)。这些设计或审查文件本身不代表全部整改已实施、验收或发布。

## 实现与验证记录

- [v2 实施台账](../.scratch/evalbase-v2/spec.md)：账号、协作和共享草稿。
- [数据处理实施台账](../.scratch/agent-data-processing/spec.md)：筛选、模型配置和数据处理基础。
- [助手实施台账](../.scratch/assistant-optimization/spec.md)：助手及后续体验、稳定性整改。
- [v2 测试计划](test-plan-evalbase-v2.md)、[处理与助手测试计划](test-plan-data-selection-and-assistant.md)：验收合同；实际结果以相应固定版本记录为准。

部分台账同时保留早期失败、旧状态和后续修复，应结合日期及对应证据阅读。文档中的“实现”“定向通过”“人工验收”“发布”分别记录，不相互替代。

## 历史基线与参考资料

[Phase 1A PRD](PRD-evalbase-v1.md)、[实现台账](agents/phase1a-progress.md)和 `system-flow-v2.*` 保留早期单人流程；[多人协作流程](system-flow-evalbase-v2.md)使用独立文件名。冻结原型位于 [prototypes/](prototypes/)，调研位于 [research/](research/)；两者都需结合之后批准的变更阅读。

`frontend-v1/` 是冻结的视觉和组件参考，当前正式应用位于 `frontend-v3/`。研究建议、原型画面和未来方案不自动成为已交付功能。
