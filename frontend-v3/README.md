# EvalBase 正式前端

[项目介绍](../README.zh-CN.md) · [启动与配置](../docs/getting-started.md)

本目录是 EvalBase 当前正式 React 前端，参与仓库 Docker 构建，由 Fastify 提供构建后的静态文件。旧视觉与组件参考位于 `../frontend-v1/`。

## 技术与入口

- React、TypeScript、Vite。
- TanStack Router 文件路由：`src/routes/`，公共外壳为 `src/routes/__root.tsx`。
- TanStack Query 管理服务端数据；Tailwind CSS 与既有 UI 组件保持视觉一致。
- `src/main.tsx` 挂载应用；`src/router.tsx` 创建路由。生成的 `src/routeTree.gen.ts` 不手工编辑。

页面包括项目与原始数据、测试集/草稿、数据处理、独立项目助手和设置；实际业务通过同源 `/api` 调用服务端，权限由服务端复核。

## 开发

从仓库根目录安装依赖：

```bash
npm ci
npm --prefix frontend-v3 ci
```

先按[启动说明](../docs/getting-started.md)准备 API、数据库、对象存储和 Worker，再启动前端热更新：

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:3000 npm --prefix frontend-v3 run dev
```

`/api` 默认代理到 `http://127.0.0.1:3000`。使用 Vite 开发地址访问页面时，后端 `APP_ORIGIN` 应匹配浏览器实际使用的前端 Origin，保持原有 CSRF/Origin 校验；不要为代理关闭认证或权限检查。

## 构建与检查

从仓库根目录运行：

```bash
npm --prefix frontend-v3 run typecheck
npm --prefix frontend-v3 run build:formal
```

`build:formal` 输出到仓库 `dist/web`，由 Web 服务提供。根目录 `npm run build` 同时生成这份正式前端和 `dist/server`；仅启动后端源码不会自动重建前端。

按受影响页面选择集成/浏览器检查；不要把仅展示的文档更新当作必须重建部署的理由。贡献与验证规则见[贡献指南](../CONTRIBUTING.zh-CN.md)。

## 修改约定

正式交互以当前产品合同和已确认变更为准，视觉继续对齐 `frontend-v1/` 的字体、颜色、间距及合适组件。冻结原型和历史目录保持原义；迁移边界见[前端复用说明](../docs/architecture/phase1a-frontend-reuse.md)。
