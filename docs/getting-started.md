# 启动与配置

[项目介绍](../README.zh-CN.md) · [文档导航](README.md)

本文针对当前检出代码，示例命令使用 Bash。需要 Docker Engine、Docker Compose v2，以及首次构建时可访问容器镜像仓库和 npm。源码开发使用 Node.js 24 和 npm。

如尚未克隆仓库：

```bash
git clone https://github.com/iflabx/evalbase.git
cd evalbase
```

随后检出与所阅读文档一致的分支或 Tag，再按下面的步骤启动。

## 配置选择

仓库默认 `compose.yaml` 保留 Phase 1A 的合成测试凭据、`SOLO_OWNER_MODE=true` 和普通 Worker。它没有配置模型 Worker，也不会仅因创建 `.env` 就覆盖写死在 YAML 中的测试凭据。

下面是**全新、隔离的本地开发实例**的补充配置。已有部署应继续使用自己的配置、项目名和数据卷；旧单人实例先阅读[账号升级说明](runbooks/v2-account-upgrade.md)。生产部署以 [生产配置模板](../compose.production.example.yaml)为起点，配置真实凭据和访问地址；该模板仍需补充模型 Worker 及共享加密密钥，不能将本地示例直接作为生产配置。

## 启动本地账号与模型功能

先检出准备运行的 Tag 或分支，在仓库根目录操作。

1. 生成一次模型凭据加密密钥：

   ```bash
   openssl rand -base64 32
   ```

   将结果加入本实例自己的 `.env`，保留文件中已有配置：

   ```dotenv
   MODEL_ENCRYPTION_KEY=<上一步生成的完整 Base64 字符串>
   ```

   这是加密模型 API key 的部署密钥，不是模型服务的 API key。Web 与模型 Worker 必须使用同一密钥；重启时保留它，备份时连同部署配置妥善保管。

2. 在仓库根目录创建本地配置 `compose.local.yaml`：

   ```yaml
   services:
     web:
       environment: &account-environment
         SOLO_OWNER_MODE: "false"
         ALLOW_TEST_IDENTITY: "false"
         MODEL_ENCRYPTION_KEY: ${MODEL_ENCRYPTION_KEY:?set MODEL_ENCRYPTION_KEY}
     worker:
       environment:
         <<: *account-environment
         WORKER_TASK_GROUP: ordinary
     model-worker:
       extends:
         file: compose.yaml
         service: worker
       environment:
         <<: *account-environment
         WORKER_TASK_GROUP: model
       networks: [edge, internal]
   ```

   普通 Worker 保持内部网络；模型 Worker 增加可访问模型服务的网络。两者复用同一程序，分别领取普通任务和模型处理任务。缺少模型 Worker 时，处理任务可能一直等待，即使 Web 页面和数据库健康检查正常。

3. 启动并检查：

   ```bash
   export GIT_SHA=$(git rev-parse HEAD)
   docker compose -f compose.yaml -f compose.local.yaml config --quiet
   docker compose -f compose.yaml -f compose.local.yaml up -d --build
   docker compose -f compose.yaml -f compose.local.yaml ps
   curl http://127.0.0.1:3000/health/ready
   ```

   首次 Web 启动会执行数据库迁移。访问 [本地页面](http://127.0.0.1:3000)，空实例创建首个管理员，随后使用邮箱和密码登录。注册普通账号后，由管理员在项目中管理成员权限。

   `/health/ready` 核对 Web、PostgreSQL 与 MinIO，返回的 `git_sha` 应对应启动时记录的代码提交。模型连通性和任务消费还需在设置及小规模处理流程中单独核对。

4. 管理员在设置中的模型连接页填写 OpenAI 兼容端点、API key、可选模型和当前模型，测试连接后保存。模型服务需能从 Web 和模型 Worker 所在网络访问；项目助手需要兼容的工具调用能力。API key 不写入前端配置或 README。

   `ASSISTANT_CONTEXT_WINDOW_TOKENS` 是服务端的上下文容量策略；如需配置，应给 Web 和模型 Worker 使用一致值，且不超过所选模型实际支持的窗口。不要以增大该值代替修复模型接口或任务错误。

停止容器并保留数据：

```bash
docker compose -f compose.yaml -f compose.local.yaml down
```

PostgreSQL 和 MinIO 数据保存在各自卷中。升级与备份应保留二者及加密密钥的对应关系。

## 第一次使用

- **已有记录**：上传 CSV、JSON 或 JSONL → 映射问题、期望输出和 Metadata → 选取记录到草稿 → 按需处理并审核 → 发布版本。
- **只有背景文档**：打开项目助手新会话，上传 PDF、Markdown 或 TXT，描述目标和数量，先核对方案，再执行生成。
- **普通提示示例**：“根据这份文档准备10条客服意图测试数据，先给方案。”需求变化时直接补充；不需要用户编写工具名或工具参数。
- **处理现有草稿**：从草稿进入数据处理，核对结果后保存回来源草稿；另存是明确选择的另一目标。
- **确认与恢复**：只规划不会自动生成。候选产生后先核对，再确认保存；停止、失败或额度不足时查看当前状态，并通过现有继续、重试或额度入口处理。普通“继续”不增加预算。

模型审核仅作为辅助。题目是否完整、期望输出是否正确，以及分类是否符合业务，仍需人工检查。

## 源码开发

安装服务端与正式前端依赖：

```bash
npm ci
npm --prefix frontend-v3 ci
```

为本地进程配置可访问的 `DATABASE_URL`、`MINIO_ENDPOINT`、`MINIO_PORT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY` 和 `MINIO_BUCKET`。Compose 内部服务名不能直接当作宿主机地址使用。Node/npm 的这些开发命令不会自动读取 Compose 的 `.env`，需显式传入环境变量。

```bash
npm run db:migrate:dev
npm run build
npm run dev
```

`npm run dev` 启动源码 Web 和普通 Worker；模型处理还需要另一终端在同一环境配置下运行：

```bash
WORKER_TASK_GROUP=model npm run dev:worker
```

Web 默认提供已构建的 `dist/web`。前端热更新与 API 代理见[正式前端说明](../frontend-v3/README.md)。按改动选择检查，命令及贡献要求见[贡献指南](../CONTRIBUTING.zh-CN.md)。
