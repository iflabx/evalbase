# AgentEval Hub Web

> [!IMPORTANT]
> 本目录是第一版 Lovable 前端，仅作为 AgentBench Phase 1A 的设计和源代码 donor，
> 不是第二版产品合同或当前正式实现。复用前先阅读
> [Phase 1A 旧版前端复用与迁移说明](../docs/architecture/phase1a-frontend-reuse.md)。
> 正式 Web 只能按该说明选择性迁移，不把本目录作为第二个部署单元。

Lovable 原型迁移后的 Vite 静态 SPA。页面继续使用 React、TanStack Router、
TanStack Query 和 Tailwind CSS，服务端能力由仓库中的独立服务提供。

以下命令只用于检查旧版 donor，不是 Phase 1A 的 npm 标准命令。

## 本地开发

```sh
corepack pnpm install
corepack pnpm --dir frontend-v1 dev
```

## 验证

```sh
corepack pnpm --dir frontend-v1 lint
corepack pnpm --dir frontend-v1 typecheck
corepack pnpm --dir frontend-v1 test
corepack pnpm --dir frontend-v1 test:e2e
corepack pnpm --dir frontend-v1 build
```
