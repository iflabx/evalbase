# Phase 1A-18：复制 donor 并建立无登录的两页前端壳

Status: ready-for-agent
Implementation: completed

> Historical implementation record: Ticket 18 accurately records the completed `frontend-v2/` experiment. The frozen v5 prototype contract adopted afterward supersedes its two-page shell, `/materials` first screen, and `frontend-v2/` development direction. Do not reopen or extend this Ticket; Ticket 20 starts the replacement frontend by copying `frontend-v1/` to `frontend-v3/`.

Blocked by: none. `ready-for-agent` 不等于开工授权；必须等待 Project Owner 明确确认本 Ticket。

## Outcome

完整复制 `frontend-v1/` 为 `frontend-v2/`，在副本中建立冻结原型的正式两页壳和独立非生产预览入口。Owner 打开地址后直接进入“原始资料”，不经过登录页、按钮或凭据输入。

本 Ticket 只建立可持续承接后续纵向功能的壳，不实现资料集合、上传、测试集或正式运行切换。

## Required reading

- [Implementation Spec](../spec.md)，尤其是前端迁移和 G-03
- [PRD](../../../docs/PRD-v2-test-data-management.md)
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [Frozen prototype record](../../../docs/prototypes/solo-workflow-reference-adaptations.md)
- [Gap audit](../../../docs/reviews/phase1a-solo-workflow-api-gap-audit.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Vertical slice

| Layer       | Deliverable                                                                              |
| ----------- | ---------------------------------------------------------------------------------------- |
| Source      | 在固定 HEAD 完整复制 `frontend-v1/` 到 `frontend-v2/`；永久保持 donor 不变               |
| Server seam | 以最小非交互式 bootstrap 将受限非生产请求绑定唯一 Owner；保留 Origin/CSRF 和项目范围边界 |
| UI          | 只保留 donor 字体、样式、外壳和所需组件；一级导航只有“原始资料”和“测试集”                |
| Preview     | 独立非生产预览，不替换当前正式 Web，也不形成第二套长期部署                               |

## Acceptance Criteria

1. `frontend-v1/` 被完整复制到 `frontend-v2/`，记录 donor commit 和复制清单；`git diff -- frontend-v1` 为空。
2. `frontend-v2/` 直接使用 donor 的字体、视觉 token、布局和所需组件，不另建主题或凭截图仿制。
3. 打开预览地址直接进入 `/materials`；不存在登录页、登录按钮、凭据字段、用户选择、成员或角色管理。
4. 服务端只为当前受限非生产单 Owner 场景非交互式解析 Owner 身份；Origin/CSRF、项目范围、审计 actor 和跨项目边界仍有效。
5. 一级导航严格只有“原始资料”和“测试集”；两页提供与冻结原型一致的空状态和后续功能占位，不显示旧 donor 业务。
6. `/materials`、`/test-sets` 的刷新、直接链接和浏览器前进/后退正常；窄视口仍可使用。
7. donor 的 Mock store、浏览器 parser、旧 Dataset/Langfuse/evaluation/report/settings 等不进入新运行壳。
8. 预览入口不修改正式 `src/web/` 运行路径、不新增公网暴露、不宣称生产认证或 Production Gate 通过。

## Necessary tests

- 正常：浏览器打开预览后直接进入原始资料，并可切换两个一级页面。
- 关键边界：伪造跨 Origin 写请求被拒绝，同时页面中不存在任何登录步骤。
- 静态：运行 `frontend-v2` 受影响的 typecheck、lint 和 build，并证明 `frontend-v1/` 无 diff。

不要求运行无关后端全套、历史 Ticket Closure Matrix 或性能 Spike。

## Owner checkpoint

Owner 打开预览地址后应能直接看到原始资料空状态，切换到测试集再返回；页面视觉应与 donor 一致，且全程看不到登录、成员和角色。

## Out of scope

- 资料集合、上传、资料记录、测试集、版本、下载、Trash 和正式 cutover。
- 密码、SSO、真实多人、生产认证或公网部署。

## Definition of Done

- AC 和必要测试通过，P0/P1 Standards/Spec 问题关闭。
- Ticket Comments 与进度表记录真实 commit 和验证命令。
- 本地提交后停止，不自动开始 Ticket 19。

## Comments

### 2026-08-31 replacement

- 原三域 Ticket 18 已由冻结两页原型和新合同取代。
- Project Owner 明确纠正：冻结原型没有登录，正式产品不得增加登录步骤。

### 2026-08-31 implementation closure

- Implementation commit: `5e1972c` (`feat(frontend): add v2 workflow shell and preview`). 从 donor commit `0adf9059a8732743fc5e56c46d3d79df0023f3cb` 完整复制 `frontend-v1/` 到 `frontend-v2/`，保留字体、视觉 token、布局和通用组件，移除 donor 旧业务运行路由，建立只含“原始资料”和“测试集”的无登录两页壳与独立非生产预览入口。服务端加入显式非生产环境的空请求 Owner bootstrap；`frontend-v1/` 未修改。
- Necessary validation: `frontend-v2/npm test -- --run src/router.test.ts`（2/2）、`frontend-v2/npm run typecheck`、`frontend-v2/npm run lint`（0 errors，6 条 donor Fast Refresh warnings）、`frontend-v2/npm run format:check`、临时输出目录 `frontend-v2/npm run build -- --outDir /tmp/agentbench-v2-build.*`、root `npm run typecheck`、相关 root 单测（18 files / 131 tests）、root `npx eslint`、root `npx prettier --check`、`npm run docs:check` 和 `git diff --check` 均通过。
- Standards/Spec review: 固定基线 `c9b571e` 的最终双轴复核均无 P0/P1/P2；AC-1–AC-8 已按实现和公共 seam 复核。当前非生产 Server Development Gate 仍为 `Passed`，Production Gate 仍为 `Not Evaluated / Not Approved`，本 Ticket 不构成正式前端切换。
- Browser revalidation: 使用隔离的 `mcr.microsoft.com/playwright:v1.62.1-noble` 临时容器（`--network none`，只挂载 `frontend-v2`）运行 `workflow-shell.spec.ts`，2/2 通过；此前宿主机 Chromium 缺少 `libatk-1.0.so.0` 的失败是运行环境问题，不作为代码失败证据。
- Untested claims: Owner bootstrap 集成测试未在本轮重跑，因为宿主机无法解析 Compose 内部 `minio` 服务名；不能伪造新的集成结果。此前独立预览/内部网络记录可作为历史证据，但不能替代后续环境可用时的重跑。Ticket 19 不因本 Ticket 自动开始，仍需 Project Owner 单独授权。
