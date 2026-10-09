# OPT-10 验收反馈：数据处理页

2026-10-09 Owner 授权修复。基线 `4e1ac254b3cfc92ac82d22f87d9be2f4fc6ab4d8`，应用 `4ee577c`；沿用当前分支和 4217。此项是数据处理页面反馈，不改助手候选计算或原会话恢复。

## 范围及页面对齐

| 位置 | 修复合同 | 样式及边界 |
| --- | --- | --- |
| 输入选择 | 问题、期望输出、Metadata 同行默认可见；长问题仍可展开 | 复用 donor 表格和 MetadataSummary，前两项及其余项展开、空值可查看；分页和选择规则不变。 |
| 页面状态 | 配置、结果、任务列表分别显示，配置及结果可返回处理任务 | 复用既有 URL 参数；结果返回清除来源及运行参数，刷新与前进后退按 URL 恢复。任务列表不在配置或结果下方重复出现。 |
| 结果对照 | 原文及结果的期望输出、Metadata 默认可见 | 复用既有两栏对照和 MetadataSummary，不新增弹窗或隐藏数据。 |
| 状态及权限 | 原错误、运行进度、重试、取消、采用确认保留 | 全部公开 API reused，不改变权限、记录内容、模型调用或采用行为。 |

仅修改正式 frontend-v3、现有浏览器用例及必要文档。冻结原型、frontend-v1 保持只读。Owner 本次反馈覆盖该页面此前把 Metadata 放在问题折叠区和任务列表常驻的展示。

## 验证记录

- 修前 Computer Use：Metadata column 数量 0，配置页“处理任务”可见，复现两项反馈。
- 现有 processing.spec.ts 增加默认 Metadata、三种页面状态及结果→列表→结果断言，保留采用幂等和旧成功运行补足重试用例。
- 服务器宿主测试初始被既有构建目录权限及浏览器缺少 libatk 阻断；不修改系统或无关目录，改用已有 Playwright 1.62.1 容器和本工作树独立临时构建目录。
- 最终定向浏览器回归 **2 passed / exit 0，23.6 秒**：Metadata 默认可见、配置/结果/列表互斥、结果返回任务再查看、采用确认及刷新不重复写入、旧成功运行的缺失记录重试。修前为 1 failed / 1 passed，失败正是配置页同时出现任务列表。
- frontend-v3 typecheck、受影响 ESLint、docs:check、前端正式构建均 exit 0；窄窗口用例和真实 Computer Use 的 480px 结果页无页面横向溢出（clientWidth/scrollWidth 同为 465）。真实页面刷新、返回任务、浏览器前进后退及两侧 Metadata 均核对通过。
- Standards、Spec 两名代理仅审本轮差异，均无 P0/P1/P2；不代签测试或 Owner 验收。Owner 验收 pending。

## 固定环境

最终前端应用提交 `963a92b5485568d5434551b7af9946e20700de09`；Web 镜像 `evalbase-agent-checkpoint:963a92b54855`，revision 标签与 `/health/ready.git_sha` 均一致，ready 为 200。后台实现保持 `4ee577c0d0f3e4d8def90fb12153d78740fdcd98`，两个 Worker 的原容器 ID 与镜像均未改变。

常规 Docker 构建及首轮浏览器容器启动发生环境等待，未宣称这些阻塞尝试通过。最终仅从当前固定 4ee577c 运行镜像复制本轮已编译静态前端，构建 exit 0 后 `up -d --no-deps web`；后端及依赖无变化。临时 Dockerfile 使用以下内容，构建上下文仅为本轮前端产物目录，没有配置或凭据：

```dockerfile
FROM evalbase-agent-checkpoint:4ee577c0d0f3
COPY . /app/dist/web/
LABEL org.opencontainers.image.revision=963a92b5485568d5434551b7af9946e20700de09
LABEL evalbase.backend.revision=4ee577c0d0f3e4d8def90fb12153d78740fdcd98
```

验收库仍为 1 项目、2 账号、29 会话、76 个处理运行；未新增处理、采用或发布。临时测试仅用 mock API，无新增验收数据。

[输入页截图](evidence/processing-ui-input.png)、[结果页截图](evidence/processing-ui-results.png)、[验证摘要](evidence/processing-ui-verification.json)。源配置通过原文件或版本/草稿的“处理数据”进入；配置与结果通过“返回处理任务”查看已有任务。

本轮只更新同一隔离 checkpoint 的 Web，Worker/Model Worker 保留 4ee577c。不合并 main、不推送、不正式部署，不新增验收项目或账号。
