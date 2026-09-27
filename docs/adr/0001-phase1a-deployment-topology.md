# Phase 1A 技术栈与部署拓扑

- Status: Accepted
- Date: 2026-08-18
- Amended: 2026-09-27
- Decision role: Project Owner / Sole Developer

Phase 1A 使用一个 TypeScript 代码库和 Node.js 24 LTS：React + Vite 构建浏览器单页应用，Fastify 5 同时提供静态资源和 HTTP API，独立 Node.js Worker 复用框架无关的深模块。包管理器使用 npm，依赖锁定使用 `package-lock.json`，可重复安装入口为 `npm ci`。部署服务器运行 Web、Worker、PostgreSQL、MinIO 四个长期部署单元；只有 Web 的可配置 `WEB_PORT` 绑定 Project Owner 已批准的访问地址，默认值为 `3000`，Owner 可选择其他未占用端口。

目标共享服务器使用 EvalBase 专用 Compose project name、内部 network、named volumes、数据库和 bucket，不复用或修改其他项目资源；PostgreSQL 与 MinIO 不发布宿主机入站端口。访问路径、绑定地址和端口由 Owner 确定。该选择以单人维护和一个语言契约为优先，不引入 SSR、Next.js、NestJS、Redis、消息代理、微服务或独立前端服务器。

标准命令为 `npm run dev`、`npm test`、`npm run test:integration`、`npm run test:e2e`、`npm run typecheck`、`npm run lint`、`npm run build` 和 `npm run db:migrate`。离线校验器不再是冻结原型对应的当前产品入口。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#2-运行拓扑)。
