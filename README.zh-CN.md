# EvalBase

[English](README.md)

EvalBase 是一个面向单一维护者的测试数据管理应用，用于整理原始资料、创建不可变的测试集版本、记录逐条数据溯源并导出 CSV。

## 功能

- 在项目范围内管理数据集和测试集。
- 通过确认流程上传 CSV、JSON 和 JSONL，并使用拖拽映射字段。
- 浏览统一记录和受大小限制的原始文件预览，支持搜索、分页和行高控制。
- 创建线性或分支式的不可变测试集版本，并查看来源与修改事实。
- 下载数据 CSV 和溯源 CSV；从回收站恢复，并通过精确输入永久删除。

## 架构

Docker Compose 会运行 Fastify Web/API、后台 Worker、PostgreSQL 和 MinIO。PostgreSQL 与 MinIO 位于 Docker 内部网络，不发布宿主机端口。正式 React 前端位于 `frontend-v3/`。

## 快速启动

前提条件：Docker Engine 与 Docker Compose v2。首次启动还需要能够拉取已固定版本的镜像。

```bash
git clone git@github.com:iflabx/evalbase.git EvalBase
cd EvalBase
cp .env.example .env
```

在 `.env` 中为 `POSTGRES_PASSWORD`、`MINIO_ROOT_PASSWORD` 和 `OWNER_PASSWORD` 分别填写 URL-safe 随机值。每个值可使用一次 `openssl rand -hex 32` 生成。

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose up -d --build
curl http://127.0.0.1:3000/health/ready
```

在浏览器打开 <http://127.0.0.1:3000>。EvalBase 使用单人、无登录工作流。Web 默认仅绑定 loopback；只有访问路径确有需要时，才同时修改 `WEB_BIND_ADDRESS`、`WEB_PORT` 与 `APP_ORIGIN`。

停止服务但保留数据：

```bash
docker compose down
```

删除本地 PostgreSQL 与 MinIO 的全部数据：

```bash
docker compose down -v
```

## 本地开发与检查

本地开发需要 Node.js 24 和 npm。

```bash
npm ci
npm --prefix frontend-v3 ci
npm test
npm run typecheck
npm run lint
npm run docs:check
npm run build
```

准备 `.env` 后，可通过隔离的 Compose profile 运行集成测试：

```bash
docker compose --profile test run --rm test
```

## 数据边界

- 单个原始文件：最多 50,000,000 bytes、10,000 条原始记录。
- 一次编辑：最多 5 个文件、100,000,000 原始 bytes、10,000 条原始记录。
- 单个已发布版本：最多 10,000 条正式记录、100,000,000 规范化 bytes。

这些是 Phase 1A 限制，不是容量承诺。

## 文档

- [产品需求](docs/PRD-v2-test-data-management.md)
- [领域词汇](CONTEXT.md)
- [架构](docs/architecture/phase1a-architecture.md)
- [系统流程](docs/system-flow-v2.md)
- [冻结交互原型](docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)
- [测试说明](docs/test-plan-phase1a.md)

## 贡献、安全与许可证

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目采用 [Apache-2.0](LICENSE) 许可证。
