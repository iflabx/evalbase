# frontend-v2 历史目录规则

`frontend-v2/` 是 Tickets 18–19 已完成实验的历史证据，已被冻结 v5 原型合同取代。不得在本目录继续产品开发、构建预览、部署、迁移新功能或把它作为回滚目标。

`frontend-v1/` 继续作为不可修改的视觉与组件 donor。Ticket 20 必须从 `frontend-v1/` 完整复制新的 `frontend-v3/`，之后所有正式前端开发仅发生在 `frontend-v3/`。

只有为了调查历史实现且不修改文件时才读取本目录。若任务要求修复当前产品行为，应先阅读仓库根目录 `AGENTS.md`、冻结原型记录、现行 PRD、`CONTEXT.md`、架构、相关 ADR、Spec、Test Plan 和当前 Ticket，并在 `frontend-v3/` 对应 Ticket 中实施。
