# EvalBase 前端工作区

`frontend-v2/` 是 EvalBase Phase 1A 正式前端的工作目录。它从只读 donor
`frontend-v1/` 复制而来；`frontend-v1/` 永远不修改，也不是第二个部署入口。

## 当前边界

Ticket 18 建立冻结单人原型的两页前端壳，Ticket 19 在原始资料页接入了最小资料集合能力：

- 打开预览后直接进入“原始资料”，不显示登录、凭据、成员或角色管理；
- 一级导航只有“原始资料”和“测试集”；
- “原始资料”页可读取集合、创建/重命名普通集合，并打开集合查看文件摘要；固定“未整理”不可改名或删除；
- 上传、记录浏览、测试集、版本、下载和 Trash API 仍由后续 Ticket 接入；
- 预览是非生产、独立的检查入口，不替换仓库当前 Web，也不代表 Production Gate 通过。

服务端无凭据 Owner bootstrap 只有在明确的非生产 `NODE_ENV` 且
`SOLO_OWNER_MODE=true` 时启用；生产环境和未声明环境默认关闭。

后续 Ticket 只在本目录中按冻结原型逐步接入真实后端能力。

## Donor 基线与复制清单

| 项目               | 记录                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Donor              | `frontend-v1/`                                                                                                                        |
| Donor commit       | `0adf9059a8732743fc5e56c46d3d79df0023f3cb` (`chore: add v1 frontend donor and reuse guidance`)                                        |
| 正式副本           | `frontend-v2/`                                                                                                                        |
| 保留内容           | React/Vite 入口、Tailwind token、字体、布局外壳、Sidebar、`src/components/ui/`、hooks、公共 lib、静态资源和构建配置                   |
| 本 Ticket 新入口   | `src/workflow-routes/`、`src/components/app-sidebar.tsx`、`src/components/workflow-state.tsx`                                         |
| 已从副本运行源移除 | donor 的旧 `src/routes`、`src/services`、`src/types` 及其 Dataset/Langfuse/计算/报告/设置页面；新的路由树只包含本 Ticket 的工作流路由 |

复制后的生成目录（`node_modules/`、`dist/`、`test-results/`）不纳入版本控制。

## 本地开发

安装和通用开发命令必须在本目录执行：

```sh
cd /path/to/EvalBase/frontend-v2
npm install
npm run dev
```

通用命令使用 Vite 默认端口 `5173`，只有当后端的 `APP_ORIGIN` 也设置为
`http://127.0.0.1:5173` 时才适合直接使用。为避免端口或 Origin 漂移，Ticket 19
预览请使用下面两台终端中的完整命令；后端命令必须在仓库根目录执行，前端命令必须在
`frontend-v2/` 执行。`SOLO_OWNER_MODE=true` 仅用于本地非生产无凭据 Owner bootstrap，
不会开启生产登录旁路。

终端 1（仓库根目录，Ticket 19 专用 Web）：

```sh
cd /path/to/EvalBase
DATABASE_URL='postgresql://agentbench_ticket19:synthetic-ticket19@127.0.0.1:55419/agentbench_v2_ticket19' \
MINIO_ENDPOINT=127.0.0.1 MINIO_PORT=59019 \
MINIO_ACCESS_KEY=agentbench-ticket19 MINIO_SECRET_KEY=synthetic-ticket19 \
MINIO_BUCKET=agentbench-v2-ticket19 APP_ORIGIN=http://127.0.0.1:4191 \
SOLO_OWNER_MODE=true ALLOW_TEST_IDENTITY=false NODE_ENV=development \
HOST=127.0.0.1 PORT=4190 npm run start:web
```

终端 2（`frontend-v2/` 预览）：

```sh
cd /path/to/EvalBase/frontend-v2
VITE_API_TARGET=http://127.0.0.1:4190 \
npm run dev -- --host 127.0.0.1 --port 4191 --strictPort
```

浏览器打开 `http://127.0.0.1:4191/materials`。前端地址必须与后端
`APP_ORIGIN` 完全一致；若改用其他端口，必须同步修改这两个值。

### Ticket 19 预览依赖

上面的 Web 进程只连接 Ticket 19 专用的合成数据依赖，不得复用其他项目的
PostgreSQL、MinIO、network 或 volume。当前验证环境的两个容器名是
`agentbench-ticket19-test-postgres` 和 `agentbench-ticket19-test-minio`；若它们已经
存在但已停止，只执行：

```sh
docker start agentbench-ticket19-test-postgres agentbench-ticket19-test-minio
```

首次创建依赖时，仅在这两个容器名和端口没有被占用的情况下执行下面的命令。镜像使用
固定 digest，数据只写入带 Ticket 名称的 named volume：

```sh
docker network create agentbench-ticket19-preview-net
docker volume create agentbench-ticket19-preview-postgres-data
docker volume create agentbench-ticket19-preview-minio-data
docker run -d --name agentbench-ticket19-test-postgres \
  --network agentbench-ticket19-preview-net \
  -e POSTGRES_DB=agentbench_v2_ticket19 \
  -e POSTGRES_USER=agentbench_ticket19 \
  -e POSTGRES_PASSWORD=synthetic-ticket19 \
  -p 127.0.0.1:55419:5432 \
  -v agentbench-ticket19-preview-postgres-data:/var/lib/postgresql/data \
  public.ecr.aws/docker/library/postgres@sha256:64154d0babcb1741988719e703419af0382b19953706149f9872fbd0f438efa8
docker run -d --name agentbench-ticket19-test-minio \
  --network agentbench-ticket19-preview-net \
  -e MINIO_ROOT_USER=agentbench-ticket19 \
  -e MINIO_ROOT_PASSWORD=synthetic-ticket19 \
  -p 127.0.0.1:59019:9000 \
  -v agentbench-ticket19-preview-minio-data:/data \
  minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936 \
  server /data
```

依赖首次就绪后，在仓库根目录执行一次可重复迁移，再启动终端 1 的 Web 命令：

```sh
cd /path/to/EvalBase
DATABASE_URL='postgresql://agentbench_ticket19:synthetic-ticket19@127.0.0.1:55419/agentbench_v2_ticket19' \
npx tsx src/db/migrate.ts
```

## 必要验证

```sh
npm test -- --run src/router.test.ts
npm run typecheck
npm run lint
npm run build
npm run test:e2e
```
