# EvalBase v2 批次 A：固定代码闭环复审

- 复审代码 HEAD：`f129936`；基线：`9a3b5b3`；范围：V2-01、V2-02。
- 权威合同：[PRD](../PRD-evalbase-v2.md)、[CONTEXT](../../CONTEXT.md)、[架构](../architecture/evalbase-v2-architecture.md)、[ADR 0012](../adr/0012-v2-account-and-project-authorization.md)、[实施 Spec](../../.scratch/evalbase-v2/spec.md)。
- 变更面：身份表迁移、安装初始化与旧 Owner 绑定、会话和项目权限、邀请及成员、前端认证和设置页；不涉及草稿实时协作或正式部署。

## Standards

- 已检查仓库指令、权限事实的服务端执行、迁移可回退边界、测试夹具隔离、原型 UI 对齐和变更文件的静态检查。未发现剩余 P0/P1。
- P1 修复：首个实现提交 `d69e749` 仅清除项目列表缓存；账号切换可能留下其他账号的前端查询缓存。`f129936` 在登出和会话失效时重新载入前端；浏览器以查看者登出、管理员登录，看到管理员资料和两个项目，无查看者缓存。
- P2：现有 `app.ts` 路由集中，新增账号路由使该文件继续增大；本批没有引入另一套授权事实，后续模块拆分应以稳定接口为前提。

## Spec

| 验收面 | 证据与结论 |
| --- | --- |
| 首次管理员唯一、普通注册不入项目 | 并发初始化、未初始化拒绝普通注册和跨项目拒绝的集成测试通过；浏览器看到未入项目账号的信息页与空项目态。 |
| 会话与权限 | 登录、登出旧会话失效、管理员全项目、编辑者写入与查看者只读、原始文件下载的集成测试通过；浏览器查看者只看到所属项目且没有写入入口。 |
| 邀请与成员 | 未注册邮箱拒绝、撤销/过期/重邀、本人接受、双请求同时接受仅有一条成员关系、改角色/移除即时生效的集成测试通过。 |
| 个人资料与原型 | 名称/颜色有效性和持久化测试通过；浏览器核对登录、项目、设置、管理员成员页、未入项目账号信息页及窄窗口布局，按冻结原型和 frontend-v1 控件样式实现。 |
| 旧实例升级 | 合成旧 Owner 绑定保留 ID 和密码哈希，登录及项目读取通过；操作与失败恢复步骤见[升级手册](../runbooks/v2-account-upgrade.md)。 |

## 验证边界

- `tests/integration/v2-accounts.test.ts`：5/5；`npm test -- --reporter=dot`：134/134；`npm run typecheck`、变更 TypeScript 定向 ESLint、前端临时目录 Vite build、`npm run docs:check` 均通过。
- 旧版 `solo-test-set-v1` 与 `solo-test-set-trash` 定向集成测试通过。旧 `permissions.test.ts` 的 10 项失败含已改写的 Owner/成员权限断言、已停用路由断言和两项需要 Worker 的超时；该套件不作为 v2 权限结论。新权限以批次 A 集成测试和浏览器实际账号为证。
- 服务器 Playwright 浏览器缺少系统 `libatk-1.0.so.0`，未运行 Playwright E2E；使用本机浏览器经 SSH 隧道做真实页面核对。没有对正式部署和其他项目运行测试。

结论：**Ticket Closure Review P0/P1 cleared at `f129936`**。Owner 浏览器 checkpoint 仍待验收；此结论不代表已合并、推送或正式部署。
