# 为 EvalBase 做贡献

[English](CONTRIBUTING.md) · [文档导航](docs/README.md)

## 报告问题

先搜索是否已有相同问题。Bug 请提供预期和实际行为、复现步骤、代码版本，以及已去除密钥和私有数据的截图或日志。

助手问题还应说明普通用户提示和中断阶段：规划、处理、确认、保存或继续；区分首次错误、自动纠正和人工干预。不要公开模型密钥、会话 Cookie、私有文档或完整私人会话。

新增行为通过 Issue 或已有获批准的功能票讨论，以适用的产品合同和已确认修订为准；调研和冻结原型本身不说明当前功能的实现状态。

## 开发环境

按[启动说明](docs/getting-started.md)准备账号、PostgreSQL、MinIO 和独立模型 Worker，安装两套依赖：

```bash
npm ci
npm --prefix frontend-v3 ci
```

配置相应环境变量后，`npm run dev` 启动源码 Web 和普通 Worker；模型处理还需 `WORKER_TASK_GROUP=model npm run dev:worker`。Vite 热更新和 API 代理见[前端说明](frontend-v3/README.md)。

`npm run build` 构建正式前端和编译后的服务端；`start:web`、`start:worker`、`db:migrate` 使用编译产物。源码开发使用对应的 `dev:*` 和 `db:migrate:dev`。

## 检查

按本次改动选择相关验证：

| 改动           | 相关检查                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- |
| 文档           | 检查最终差异、链接、表格、代码围栏及示例；运行 `npm run docs:check`。                     |
| 后端逻辑或 API | 受影响单元/集成回归、`npm run typecheck`、`npm run lint` 及相应构建检查。                 |
| 前端           | `npm --prefix frontend-v3 run typecheck`、正式前端构建及可用的定向浏览器验证。            |
| 助手或模型处理 | 受影响的准备、执行、纠错、保存、恢复真实 SDK 链路回归；在约定预算内进行有界真实模型验证。 |

单元和集成入口为 `npm test`、`npm run test:integration`。涉及数据库和对象存储的测试使用隔离实例；真实模型测试保留旧结果和旧预算，记录实际请求，并区分自动测试与浏览器实际观察。

## Pull Request

- 聚焦当前问题，保留无关工作。
- 说明用户可见结果、验证证据和仍有的限制。
- 行为变化补充有意义的回归；启动方式或行为变化同步更新文档。
- 正式前端修改在 `frontend-v3/`，视觉继续对齐 `frontend-v1/`。
- 保留冻结原型和历史证据的原义。
- 不提交凭据、私有数据集、数据库卷或生成的构建产物。

分支、验收、合并、推送和发布遵循[开发流程](docs/agents/development-workflow.md)，仓库详细规则见 [AGENTS.md](AGENTS.md)。

## 许可证

提交贡献即表示同意以 [Apache-2.0](LICENSE) 许可证授权你的贡献。
