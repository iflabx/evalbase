# 为 EvalBase 做贡献

[English](CONTRIBUTING.md)

感谢你愿意为 EvalBase 做贡献。

## 提交 Issue 前

请先搜索是否已有相同 Issue。Bug 请提供：

- 你期望发生什么；
- 实际发生了什么；
- 可复现步骤；
- 已移除密钥和私有数据的相关日志或截图。

如果是新功能或行为调整，请先创建 Issue 讨论，再开始编写代码。EvalBase 以 PRD、架构文档和冻结交互合同为准，Pull Request 不得在未讨论的情况下扩大产品范围。

分支创建、验收合并、推送、Release 和部署的项目流程见[开发流程](docs/agents/development-workflow.md)。

## 本地开发

```bash
npm ci
npm run dev
```

如果改动需要 PostgreSQL、MinIO、Worker 或正式 Web 运行时，请启动容器化环境：

```bash
docker compose up -d --build
```

## 检查

提交 Pull Request 前，请运行与你改动相关的检查：

```bash
npm run typecheck
npm run lint
npm test
npm run docs:check
npm run build
```

如果改动影响 HTTP 路由、持久化、上传、版本、删除或浏览器交互，还应运行相关的集成测试或浏览器测试。

## Pull Request

- 每个 Pull Request 只解决一个明确问题。
- 为修改后的可见行为补充或更新测试。
- 行为、启动方式或用户可见文案变化时，同步更新文档。
- 不提交密钥、真实数据集、数据库卷、生成的构建产物或浏览器报告。
- 不修改 `frontend-v1/`，它是不可修改的视觉和组件 donor。
- 正式前端改动只能在 `frontend-v3/` 中完成。
- 在 Pull Request 描述中说明用户可见变化和验证结果。

## 许可证

提交贡献即表示你同意以 [Apache-2.0 许可证](LICENSE) 授权你的贡献。
