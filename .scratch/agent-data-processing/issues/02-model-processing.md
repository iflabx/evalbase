# AI-02 模型连接与数据处理

Status: ready-for-agent
Implementation: ready-for-owner-checkpoint
Blocked by: SEL-01

## 范围与合同

[Spec](../spec.md)、[PRD AI-01/02/03](../../../docs/PRD-data-selection-and-assistant.md)、[架构](../../../docs/architecture/data-selection-and-assistant.md)、[测试](../../../docs/test-plan-data-selection-and-assistant.md)。包括原件稍后整理、清洗/改写/扩充，不以仅做其中一种作为本 Ticket 完成。

## 路由与验证

- reused/extended：上传确认、映射预览、业务权限、草稿保存/发布、来源与对象存储。
- added：管理员模型连接/测试；已保存原件整理；项目处理运行创建、查询/分页结果、取消/重试、接受。
- retired：保持旧 /transformation-runs 和 /jobs 不可公开访问。
- 测试 seam：当前正式 HTTP + 真 PG/MinIO + 假兼容模型 + 实际 Worker；SDK 真实端点小样本另外验证。先合法配置与无凭据泄漏红测，再逐个处理闭环。

## UI parity

设置复用个人资料/成员页的左菜单、表单和反馈；上传沿用拖拽映射；处理配置与结果使用现有 PageHeader、Card、Input、Button、表格与编辑侧栏密度。原件状态、前后对照、选择接受、失败/取消必须可见。按 Owner 授权直接实现，不制作智能体原型。

## 完成要求

CONN、RAW、RUN、APPLY、TRACE、DELETE、MODEL 的相关证据齐全；正文清理与 GC 引用、生成归属、两个发布路径和旧数据兼容受测。Standards/Spec 与高风险提交边界复审无 P0/P1。完成后继续 AI-03。

## Comments

- 2026-10-04：模型连接、凭据加密、SDK 假端点测试与设置页已实现；原件确认/后整理及未整理来源保护已实现。模型连接集成 3 项、原件后整理集成 2 项、上传/原件浏览器 3 项已通过。复审发现的跨地址复用密钥、旧配置测试误报、重复字段映射、等待确认期间撤权均已增加回归并修复。后台清洗/改写/扩充、接受、来源与删除仍未完成，本 Ticket 不标完成。

- 2026-10-04：本轮功能及对应自动化和独立复审已完成；真实浏览器问题已修复。统一证据见 [验证与交接](../verification.md)。三张 Ticket 共用一个最终隔离 checkpoint；Owner 人工验收 pending，不合并或推送。
