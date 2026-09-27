# 开发分支、合并与发布流程

本流程适用于 EvalBase 开发仓库。Ticket 的实现和验收细则仍以 [AGENTS.md](../../AGENTS.md)、[测试计划](../test-plan-phase1a.md)及对应 Ticket 为准。

## 1. 从明确的基线创建分支

1. 开始前检查工作区、当前分支、`HEAD` 和 GitHub `main`。先处理本地 `main` 尚未推送的提交；保留已有改动。
2. 获取 GitHub `main` 后，只用 fast-forward 同步本地 `main`。若两端分叉，先检查和解决差异，不重置或强推任一端。
3. 从同步后的 `main` 创建 `codex/<ticket-or-topic>` 分支。依赖前一 Ticket 尚未合并时，以 Owner 确认的提交为基线，并在 Ticket 中记录依赖。
4. 一个分支承载一个明确任务。实现、测试和文档提交都留在该分支；`main` 用于集成已验收结果。

## 2. 验收与合并

1. 按 Ticket 运行直接相关的测试、静态检查和 Standards/Spec 复审，修复 P0/P1。需要浏览器 checkpoint 的 Ticket 固定提交供 Owner 验收，并记录结果及隔离资源的回收。
2. 合并前更新 GitHub `main` 的状态，审阅待合并差异，并确认验收结论仍适用于最终代码。若基线发生变化，处理冲突并复验受影响流程。
3. 获得该任务的合并授权后，将分支以 fast-forward 或普通 merge 合入本地 `main`，保留提交的祖先关系。合并后检查 `main` 的提交、工作区和受影响验证结果。
4. 只有 Project Owner 明确要求推送时才推送 GitHub `main`。推送前再次核对远端位置；远端已前进时先整合，绝不强推覆盖。

## 3. Release 与部署

- Release Tag 指向已核对的 `main` 提交；创建 Tag 和 GitHub Release 分别按 Owner 指令执行。
- 部署是独立步骤。部署检出目录只使用 GitHub `main` 或 Owner 指定的 Tag/提交，不在其中开发；保留部署专用配置、凭据和现有数据卷。
- 部署前后核对代码提交、Compose 项目与服务、端口、`/health` 和 `/health/ready`。合并或推送代码本身不算完成部署。

## 4. 分支维护

- 清理分支前确认其任务已结束、没有工作树或 Codex 会话依赖它，并核对提交仍可从保留的分支或 Tag 到达。分支名占用很小，无须仅为节省空间批量删除。
- 2026-09-27 前的 Ticket 历史曾经压缩整合到新的 GitHub `main`。这些旧分支可能显示为“未合并”，即使其代码已整合；不能仅凭 `git branch --no-merged main` 删除。保留旧历史的锚点，另行审计后再清理旧分支名。
