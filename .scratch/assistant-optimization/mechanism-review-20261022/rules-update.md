# 机制整理文档与规则更新记录

- 日期：2026-10-22。
- 授权：整理机制、给出修改方案并修改相关规定和文档；本轮只改文档与Skills。
- 仓库：/home/bistu/EvalBase/.worktrees/agent-data-processing，分支codex/assistant-optimization。
- 应用基线：92492e7a7b2a4eab2abf635226bdd6895f01997a；未更新4217运行环境。
- 方案：[机制整理](../../../docs/assistant-mechanism-consolidation-2026-10-22.md)。该方案待开发，无新的开发票或实施完成声明。

## 规则变更

项目AGENTS.md将精简定义为完整解决根因所需的最小范围，允许必要的共用逻辑收敛、内部接口调整及旧分支退出，不以文件数或差异行数限制修复。Ticket审阅协议在原有一次审阅内检查实际调用方和恢复闭环，不增加审批或完整测试轮次。

同步修改服务器已安装Skills：

| 文件 | 变更 |
| --- | --- |
| /home/bistu/.codex/skills/ponytail/SKILL.md | 去除最少文件、最短差异和一行优先的指标，保留复用与范围约束 |
| /home/bistu/.codex/skills/implement/SKILL.md | 定义完整根因范围，允许必要结构调整，检查纠错至完成的实际流程 |
| /home/bistu/.codex/skills/diagnosing-bugs/SKILL.md | 反复失败时核对共享判断和状态衔接，保留缺失证据的不确定性 |

Skills原文件备份位于本目录skills-before/，仅作回溯；有效规则仍是上述安装位置。未修改本机其他项目的AGENTS或Skills，也未修改服务器main检出目录。开发分支规则随后续获准整合传播。

## 文档组织

机制方案是详细设计的唯一入口；PRD、架构、总整改方案与实施Spec以短增补指向它。验证断言集中在测试计划§5.18，共12项受控检查和原五项Computer Use业务流程。现有各OPT和质量验收状态保持。

## 验证与保护

- 修改集合13个文件（10个仓库文档/证据、3个已安装Skills）的SHA、表格、围栏及21个新增本地链接检查通过；27处表格结构通过，无新增JSON/Mermaid示例。
- npm run docs:check通过：38张历史票生命周期、提交引用、Gate及过期状态文案。
- git diff --check通过，业务代码、前端代码、测试和依赖差异为空。
- 无模型请求、数据库写入或预算修改，未重跑已完成验收；现有数据、旧预算和历史失败保留。
- 未执行代码构建、部署、合并或推送。后续业务验收按方案授权范围另行执行。
