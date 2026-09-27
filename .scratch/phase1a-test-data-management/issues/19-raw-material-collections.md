# Phase 1A-19：资料集合与固定“未整理”

Status: ready-for-agent
Implementation: completed

> Historical implementation record: Ticket 19 accurately records the collection model and the UI/API delivered in `frontend-v2/`. The frozen v5 prototype contract supersedes its visible rename action, right-side information panel, `/materials` wording, and continued `frontend-v2/` work. Those completed implementation facts remain evidence; Tickets 20–22 provide the current Project → 数据集 contract in `frontend-v3/`.

Blocked by: [18](./18-frontend-v2-shell-and-preview.md) 已完成；本 Ticket 已获 Project Owner 授权。

## Outcome

Owner 可以在原始资料页创建、查看和重命名浅层资料集合，并使用每个项目唯一且不可删除的“未整理”。现有资料自动出现在“未整理”，不改变资产身份或来源。

## Required reading

- [Implementation Spec](../spec.md)，Raw Material Collection
- [PRD](../../../docs/PRD-v2-test-data-management.md)
- [Architecture 6.2](../../../docs/architecture/phase1a-architecture.md#62-raw-material-collection)
- [Gap audit](../../../docs/reviews/phase1a-solo-workflow-api-gap-audit.md)
- [Test plan A.0](../../../docs/test-plan-phase1a.md#a0-ticket-必要测试规则)

## Vertical slice

| Layer       | Deliverable                                                   |
| ----------- | ------------------------------------------------------------- |
| Data/domain | Collection、单资产唯一 membership、固定“未整理”和既有资产回填 |
| Public seam | 集合 list/create/rename 和集合内文件摘要；不暴露表结构        |
| UI          | `/materials` 资源管理器列表、创建/重命名操作和“未整理”入口    |

## Acceptance Criteria

1. 每个项目恰有一个固定“未整理”；不可重命名、删除或重复创建。
2. 普通集合是浅层对象，可创建、列出和重命名；不支持父集合、目录树或自定义权限。
3. 一个资产同时只属于一个集合；迁移前已有资产确定性回填到“未整理”。
4. 集合查询只返回当前项目内容；跨项目 ID 不泄漏存在性。
5. 原始资料页真实展示集合名称、文件数和最近更新时间，并能完成创建和重命名。
6. 本 Ticket 不改变资产字节、哈希、来源、Parsed View 或 locator。

## Necessary tests

- 正常：创建并重命名一个集合，重新加载后仍存在，既有资产位于“未整理”。
- 关键边界：拒绝修改固定“未整理”和跨项目集合访问。
- 静态：运行受影响的 migration/integration、typecheck、lint/build 和 docs check。

## Owner checkpoint

在预览前端创建两个领域集合，重新命名其中一个，打开“未整理”，确认页面没有目录树或治理型表单。

## Out of scope

上传、记录浏览、集合嵌套、永久删除、标签和全文搜索。

## Definition of Done

- AC 和必要测试通过；迁移可重复且不丢失既有资产。
- Ticket Comments 与进度表记录 commit 和证据；本地提交后停止，不开始 Ticket 20。

## Comments

### 2026-08-31 implementation closure

- Implementation commit: `f1b00ee` (`feat: add raw material collections`). 新增项目级浅层 `raw_material_collection`、固定且不可删除的“未整理”、既有资产确定性回填、资产默认归属和集合更新时间触发器；增加项目隔离的集合 list/detail/create/rename/delete（删除保持明确拒绝）HTTP seam 与审计；`frontend-v2` 原始资料页接入集合列表、搜索、右侧信息面板、进入文件摘要、新建和重命名。未实现上传、记录浏览、集合移动或后续 Ticket 能力。
- Follow-up fix commit: `b0516b8` (`fix: align frontend preview API origin`). Vite 预览代理支持 `VITE_API_TARGET`，并记录后端 `APP_ORIGIN` 必须与浏览器前端地址一致；这保证无登录 Owner bootstrap 在专用预览端口上可用，不改变正式 Web 或安全边界。
- Necessary validation (独立临时 PostgreSQL/MinIO，仅合成数据)：`npx tsx src/db/migrate.ts`（成功，重复执行成功）；`npx vitest run tests/integration/collections.test.ts`（2/2）；`npx vitest run tests/integration/upload.test.ts`（5/5）；`npx vitest run tests/integration/permissions.test.ts`（15/15）；`npm test`（18 files / 131 tests）；根目录和 `frontend-v2` `npm run typecheck`；`frontend-v2 npm run lint`（0 errors，6 条既有 donor Fast Refresh warnings）；受影响文件 ESLint、Prettier check、`frontend-v2` 临时输出目录 build 和 `git diff --check` 均通过。
- Full integration evidence: `npm run test:integration` 在同一独立临时依赖上完成（21 files / 193 tests，187 passed / 6 failed）。失败为既有 `job-coordination` 4 项、`observability` Worker health 1 项和 `structured-lists` 1 项；失败栈不涉及集合迁移或集合 HTTP seam，定向上传/权限/集合回归均通过。没有把该套件写成全绿结果。
- Documentation validation: `npm run docs:check`（26 个 Ticket lifecycle rows、commit references、Gate state 和 stale-status checks）及变更文档的 Prettier/diff check 均通过。Production Gate remains `Not Evaluated / Not Approved`, and Non-production Server Development Gate remains `Passed`. Ticket 20 的前置依赖已解除，但本 Ticket 不授权或开始 Ticket 20。
- Standards/Spec review: `b0516b8` 的初次 Spec 复核曾发现 preview Origin/启动前置 P1；本次文档修订补齐明确工作目录、`APP_ORIGIN`、`VITE_API_TARGET`、非生产 `SOLO_OWNER_MODE=true`、专用 PostgreSQL/MinIO 固定 digest、依赖启动和可重复迁移命令。针对该固定实现加本次文档变更的最终复核为 Standards P0=0/P1=0、Spec P0=0/P1=0，未发现需返修的问题。
