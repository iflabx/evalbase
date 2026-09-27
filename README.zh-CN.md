# EvalBase

[English](README.md)

EvalBase 是一个面向单一维护者的测试数据管理应用。它支持整理原始资料、映射与浏览记录、创建不可变的测试集版本、记录数据溯源、导出 CSV，以及安全地回收或永久删除测试集和版本。

Phase 1A 已完成。用户可见的交互合同是[冻结的单人工作流原型](docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)，正式实现位于 `frontend-v3/`。

## 功能

- 创建项目工作区，并在项目内管理数据集和测试集。
- 通过两步确认流程上传 CSV、JSON 和 JSONL 文件。
- 使用拖拽将原始字段映射到问题、期望输出和多个 Metadata 字段。
- 浏览统一记录，查看受大小限制的原始内容预览，在数据集之间移动文件，并使用搜索、分页和行高控制。
- 创建 `v1`，派生线性或分支式的不可变测试集版本，并查看逐条记录的来源与修改事实。
- 将版本下载为数据 CSV，或数据 CSV 与溯源 CSV 两个文件。
- 从回收站恢复测试集和版本分支；只有精确输入测试集名称或版本号后才能永久删除。

## 架构

Docker Compose 会运行四个服务：

| 服务       | 职责                                      |
| ---------- | ----------------------------------------- |
| Web        | Fastify API 与构建后的 `frontend-v3` 应用 |
| Worker     | 后台处理和清理任务                        |
| PostgreSQL | 项目、数据集、测试集、版本、溯源与状态    |
| MinIO      | 原始文件、暂存字节、规范化产物和 CSV 导出 |

PostgreSQL 与 MinIO 只位于 Docker 内部网络，不发布宿主机端口；只有 Web 会发布端口。

## 使用 Docker Compose 快速启动

### 前提条件

- Docker Engine 与 Docker Compose v2
- 第一次启动时可访问镜像仓库，拉取已固定的容器镜像
- 预留数 GB 磁盘空间给镜像以及本地 PostgreSQL/MinIO 卷

克隆仓库并启动应用：

```bash
git clone <你的仓库地址> EvalBase
cd EvalBase

GIT_SHA=$(git rev-parse --short HEAD) \
WEB_BIND_ADDRESS=127.0.0.1 \
WEB_PORT=3000 \
APP_ORIGIN=http://127.0.0.1:3000 \
docker compose up -d --build
```

在浏览器打开 <http://127.0.0.1:3000>。Phase 1A 只有一个非交互式 Owner，因此没有登录页面。

验证运行的版本与依赖：

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/health/ready
```

返回的 `git_sha` 应与当前检出的提交一致。停止容器但保留本地应用数据：

```bash
docker compose down
```

同时删除 Compose 卷，即删除本地 PostgreSQL 和 MinIO 中的全部数据：

```bash
docker compose down -v
```

仓库中的凭据仅是合成开发默认值，请在部署前替换。

## 本地开发与检查

本地开发需要 Node.js 24 和 npm。

```bash
npm ci
npm run dev

npm test
npm run test:integration
npm run typecheck
npm run lint
npm run docs:check
npm run build
```

需要时，在仓库的容器化环境运行浏览器测试：

```bash
docker compose --profile e2e run --rm e2e
```

完整命令和按风险选择验证的规则见 [AGENTS.md](AGENTS.md)。

## 数据与容量边界

- 单个原始文件：最多 50,000,000 bytes、10,000 条原始记录。
- 一次编辑：最多 5 个文件、100,000,000 原始 bytes、10,000 条原始记录。
- 单个已发布版本：最多 10,000 条正式记录、100,000,000 规范化 bytes。

这些是 Phase 1A 的容量限制，不是容量承诺。

## 仓库结构

| 路径                                     | 用途                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `frontend-v3/`                           | 正式 React 前端                                 |
| `src/`                                   | Fastify 服务端、领域模块、数据库、存储与 Worker |
| `tests/`                                 | 单元与集成测试                                  |
| `docs/`                                  | PRD、架构、ADR、原型记录、调研和测试计划        |
| `.scratch/phase1a-test-data-management/` | 本地 Implementation Spec、Tickets 和执行证据    |
| `frontend-v1/`                           | 不可修改的视觉与组件 donor，不参与运行          |

`frontend-v2/` 和 `src/web/` 仅保留历史源码，不进入正式构建或 Compose 运行时。

## 参与贡献

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，也提供了[中文版本](CONTRIBUTING.zh-CN.md)。

## 社区与安全

请按 [SECURITY.md](SECURITY.md) 所述方式私下报告安全问题。社区参与行为受[行为准则](CODE_OF_CONDUCT.md)约束。

## 项目状态

Phase 1A v5.3 实现序列与最终 Owner 端到端验收均已完成。实现证据见[进度台账](docs/agents/phase1a-progress.md)，权威功能范围见[PRD](docs/PRD-evalbase-v1.md)。

## 公开 Fork 前

检查所有被追踪文件，移除不应公开的私有服务器地址、凭据、Cookie、内部路径、日志或数据。不要提交 `.env`、数据库/MinIO 卷、`node_modules/`、生成的 `dist/`、浏览器报告或真实数据集。请特别检查 `.scratch/`，其中保留项目的开发历史和可能带有环境信息的证据。

本项目采用 [Apache-2.0](LICENSE) 许可证。
