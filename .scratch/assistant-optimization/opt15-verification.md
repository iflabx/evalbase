# OPT-15 实施与验证

## 范围与版本

- 2026-10-13 Owner 授权完成 [OPT-15](issues/15-ui-copy-and-information-hierarchy.md)。沿用 `/home/bistu/EvalBase/.worktrees/agent-data-processing` 与 `codex/assistant-optimization`，基线 `ae62a27`。
- 应用固定 `214d9614615bfb7e3fc0135ca16f2b9dedf28fbd`：处理页、测试集列表/草稿、设置和项目助手删减重复文案，辅助说明及历史邀请按需展开。沿用 frontend-v1 的现有组件、颜色、字体、边框和间距，无新主题、依赖或引导系统。
- 关键选择数量、筛选外选择、保存未知状态、字段保护、异常恢复、父版本、来源和修改者保留。业务接口、模型提示词、Agent/Worker、数据表及用户内容未改。
- Implementation completed，Owner checkpoint pending；旧 Ticket 状态不代签。本轮不包含合并 main、推送 GitHub、tag 或正式部署。

## 针对性检查

- 前端类型检查、受影响文件 lint、`git diff --check` 通过。固定 Git archive 构建完成服务器与正式前端构建；最后一项应用调整仅校正“查看”权限帮助的范围表述。
- 12 个不同的既有浏览器用例最终通过：处理跨页/筛选外选择、Metadata 与未知保存状态、冲突后保留目标及输入、结果继续处理、助手候选和背景/任务展示、草稿布局与窄窗口、注册邀请入口、待处理/历史邀请分离及键盘展开。
- 首轮 9 项通过、草稿断言失败：旧断言漏掉本轮之前已有的“处理数据”入口，补齐后该项通过。设置第一轮注册项通过、成员项因夹具缺少项目 access 响应而未进入成员页；仅补齐该响应，成员项单独复跑通过。保留原失败日志，不作为产品回归或一次全绿记录。
- 自动浏览器使用既有 Playwright 官方容器、1 CPU/1GB、一个 worker，访问本机 4317 的固定前端，API 由测试夹具拦截。未跑全仓后端回归、压力测试或真实模型任务。
- 主要日志：`opt15-browser.log`、`opt15-recheck.log`、`opt15-settings-final.log`、`opt15-image-build.log`、`opt15-image-final.log`。最终文档检查按根约定执行一次 `npm run docs:check`。

## 4217 与现场复核

- 仅更新 Web：`evalbase-agent-checkpoint:214d9614615b`，镜像 ID `sha256:84c8edb5d8464586018ac93f82cf4402c02e8cefdef1dfb2b5d436f2bf79690d`；Compose 执行 `up -d --no-deps web`。Web healthy，`/health`、`/health/ready` 返回上述 SHA；数据库和 MinIO ready，首页、`/api/installation` 与 `/assets/index-oirS40qK.js` 返回 200。
- 两 Worker 仍运行 `evalbase-agent-checkpoint:3b7692fcfcc0`；数据卷、现有账号、项目、任务和会话保留。临时 4317 预览及本轮测试容器在检查结束后停止/清理，4217 保留待验收。
- Computer Use 登录现有管理员，查看处理历史、100个问题_new.csv 的处理配置、测试集列表、邹豪草稿、个人资料、项目成员及既有助手会话。确认重复标题/统计移除，必要提示与来源仍可见；清洗说明、权限说明、历史邀请及上传要求可通过键盘展开，邀请历史默认折叠并显示真实数量。
- 现场仅查看与展开说明，未提交处理、保存、发布、邀请或修改数据。失败/冲突与助手空态由可控浏览器夹具核对，不宣称现场完成双账号或真实模型任务。桌面现场截图及窄窗口自动检查不替代 Owner 的最终观感验收。

## Owner 验收路径

1. 保持原 SSH 隧道，打开 `http://127.0.0.1:4217/`，沿用现有管理员/编辑账号及项目。
2. 数据处理：查看历史、新建处理并选择来源；检查数量、清洗说明、字段授权及不可用原因。打开已有结果，确认保存目标和审核信息仍清楚。
3. 测试集与草稿：核对列表、标签计数、搜索/新增工具栏、编辑空态、来源、修改者和自动保存状态。
4. 设置：核对个人资料、权限说明、待处理邀请和默认折叠的历史记录；助手：核对背景上传要求、真实任务状态与候选审核入口。

本张为展示调整的一次集中验收；上述自动化和现场检查不代替 Owner 确认。
