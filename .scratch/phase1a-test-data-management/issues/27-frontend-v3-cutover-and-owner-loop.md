# Phase 1A-27：`frontend-v3` 正式切换与单人主闭环

Status: ready-for-agent
Implementation: completed

Blocked by: [26](./26-test-set-trash-and-permanent-delete.md)（已完成）。Project Owner 已授权并验收。

## Outcome

将 Owner 逐 Ticket 检查过的 `frontend-v3/` 切换为唯一正式 Web，让 `frontend-v2/` 和 `src/web/` 退出构建/运行，并在目标非生产部署完成一次冻结原型全闭环。

## Required reading

- [Implementation Spec](../spec.md)，Completion
- [Frontend reuse](../../../docs/architecture/phase1a-frontend-reuse.md)
- [PRD acceptance](../../../docs/PRD-v2-test-data-management.md#9-phase-1a-验收)
- [Test plan final acceptance](../../../docs/test-plan-phase1a.md#f2-最终主闭环)

## Acceptance Criteria

1. 正式 build、static serving 和 Compose 只使用 `frontend-v3/`；`frontend-v1/` 无改动。
2. `frontend-v2/` 与 `src/web/` 不进入构建、预览、运行或正式回滚路径，但保留 Git 历史。
3. 正式地址无登录进入项目列表；进入项目后只有数据集和测试集子入口。
4. Owner 通过正常 UI 完成 PRD 第 9 节全部 10 步，不直接修改数据库或运行修复脚本。
5. 页面没有冻结原型之外的用户能力，尤其没有重命名、高级 parser、版本说明、Package/CLI、Langfuse、Job/Audit 或独立 Controlled Deletion。
6. 项目/主区 URL 状态与冻结原型一致；刷新具体对象可安全回到当前项目对应列表，不额外承诺完整深链接恢复。
7. 错误显示可执行恢复信息，不暴露内部 ID、堆栈或原始正文。
8. `/health.git_sha` 等于测试固定 HEAD；正常容器重启保留已确认文件和版本。
9. Web 只沿用批准地址/端口；PostgreSQL、MinIO 和 Worker 不新增宿主机入站端口。
10. 固定 HEAD 的正式路由清单只包含冻结原型所需 HTTP 动作；Tickets 20–26 标记为 `retired` 的旧路由均未注册，内部深模块仍可被任务型路由复用。

## 冻结原型对齐门槛

实现前，在本 Ticket Comments 中写出并锁定全闭环对照表：项目工作区、数据集列表/详情/记录浏览、上传与映射、测试集列表/创建/版本分支、版本详情/来源/下载、回收站；每页分别列出可见字段、控件顺序、文案、启用/禁用状态、分页/弹窗、空/错误状态和排除项。唯一交互依据是 [`THROWAWAY-phase1a-solo-workflow-ui.html`](../../../docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)。

- 正式 `frontend-v3/` 必须逐页维持冻结原型的层级、项目内侧栏缩进和关系线、图标、布局、控制顺序、页面状态与对话框；`frontend-v1/` 继续只作不可修改的视觉/组件 donor。
- 对照中还必须逐项审计原型外禁用能力：登录、成员/角色、重命名、高级 parser、版本说明、Package/CLI、Langfuse、Job/Audit 和独立 Controlled Deletion 均不得成为用户可见或可调用的产品操作。
- 关闭前必须在固定 HEAD 用可用浏览器完成页面级全闭环对照及必要恢复路径，而不只核对 API、类型检查或构建。浏览器不可用时如实记为 unavailable，不得记为通过。
- Owner 必须检查该固定 HEAD 的正式 checkpoint 并在 Comments 记录接受结论；这不是 Agent 可代替的验收，也不因技术检查通过而自动成立。

## Necessary tests

- `frontend-v3` typecheck、lint 和 production build；`frontend-v1` 无 diff；证明其他前端不在运行路径。
- 固定 HEAD 浏览器 Owner 主闭环和一个关键恢复路径。
- 固定 HEAD 公共路由清单与 Tickets 20–26 的 `reused` / `narrowed` / `retired` 记录一致。
- 健康 SHA、服务器监听、内部端口和正常重启持久化。
- 只运行本次切换直接影响的后端测试，不默认重跑全部历史套件或性能 Spike。

## Owner checkpoint

Owner 从正式地址完成 PRD 第 9 节主闭环并明确确认。Agent 不代替 Owner 声称人工验收。

## Out of scope

生产部署、公网开放、敏感数据、真实多人、SSO/密码登录、备份、Phase 1B 和任何原型外功能。

## Definition of Done

AC 与必要切换证据通过；Owner 验收真实记录；Ticket Comments 与进度表记录 commit、命令、部署参数、未运行套件和风险。本地提交后停止。

## Comments

- 2026-09-07：Project Owner 已明确授权执行。以下是固定的逐页原型对照；`frontend-v1/` 仅提供视觉、组件、图标和布局来源，冻结原型是全部交互合同。

  | 页面 | 可见字段与控件顺序 | 状态、分页与弹窗 | 明确排除 |
  | --- | --- | --- | --- |
  | 项目列表 | 搜索、项目卡片名称/描述/数据集数/测试集数、分页、新建项目 | 加载/空/错误；名称必填、描述可选的新建弹窗 | 登录、成员、角色、设置、重命名、删除 |
  | 项目内侧栏 | 当前项目名、关系线缩进的数据集/测试集入口、项目切换 | 当前入口高亮；项目切换回列表 | 平铺导航、额外工作区入口 |
  | 数据集列表 | 搜索、名称/类型/文件数/记录数/更新时间/状态、查看 | 加载/空/错误、分页、新建数据集弹窗 | 数据集重命名、删除、嵌套文件夹 |
  | 数据集文件页 | 搜索、文件名/格式/大小/记录数/上传时间/状态、查看、移动、上传 | 加载/空/错误、分页；移动和两步上传弹窗 | 文件信息侧面板、批量治理操作 |
  | 统一记录浏览 | 搜索、文件筛选、记录编号、问题/预测输出/Metadata、原始内容 | 加载/空/错误、分页；原始内容弹窗 | 高级 parser、Schema、任意映射编辑 |
  | 上传两步弹窗 | 选择文件、解析与浏览、每一原始字段映射到问题/预测输出/Metadata、确认上传 | 格式/解析错误可恢复；确认前不进入数据集 | 责任人、用途、许可、敏感级别输入 |
  | 测试集列表 | 搜索、名称/当前版本/记录数/来源/更新时间/状态、查看、新建测试集 | 加载/空/错误、分页；名称必填、用途可选 | 默认版本切换、重命名、删除按钮 |
  | 新建测试集三步 | 基本信息、按数据集/文件选记录、问题/预测输出/Metadata 编辑、创建 | 前后步、选中计数、空/错误；只在最后创建 `v1` | recipe、采样、join、dedup、多人草稿 |
  | 版本详情与关系 | 当前版本摘要在关系图上方、带箭头的父子图、来源路径高亮、灰虚线墓碑、创建新版本 | 当前节点高亮；历史/分支均可选；加载/空/错误 | 合并、rebase、重命名、版本说明 |
  | 来源与修改 | 汇总、筛选/搜索、来源文件、增加/修改/删除、记录详情 | 加载/空/错误、分页；详情弹窗 | lineage 图、证据编辑器、Audit 页面 |
  | 下载 | 顶部“查看来源与修改 / 下载 CSV / 下载数据与溯源 / 创建新版本” | 两个下载均为 CSV；下载失败可见错误 | ZIP、Package、CLI、Langfuse |
  | 回收站 | 测试集/版本分支、回收时间、恢复、永久删除、墓碑 | 加载/空/错误、分页；确认弹窗；中间版本整支回收 | 独立 Controlled Deletion 流程 |

- 2026-09-07：正式公共路由处置清单。`reused`：无交互 Owner bootstrap（`GET/POST /api/session`）、项目/数据集/待确认上传深模块、文件/统一记录浏览、单人测试集/版本/来源、CSV、回收站与墓碑深模块。`narrowed`：`/api/projects`、`/collections`、`/pending-uploads`、`/pending-upload-batches`、`/collections/:collectionId/(assets|records)`、`/assets/:assetId/collection`、`/solo-test-sets`、`/solo-test-set-trash` 的请求与 DTO 只保留冻结原型所需字段。`retired`：直接 `/assets` 上传/列表/删除、资产 attribution/audit/archive/parse-attempts/records、`parsed-views`、`jobs`、`drafts`、`candidates`、旧 `test-sets`、Package/Delivery/Langfuse、transformation、lineage trace 和旧 deletion 入口；它们不再公开注册，外部访问固定为 `route_not_found`。保留原始内容查看所需的 `GET /api/projects/:projectId/assets/:assetId/download?view=raw`。

- 2026-09-07：逐页复核标签和状态基线如下；每页均保留加载、空、错误、可重试和原型分页。

  | 页面 | 固定标签和控制顺序 | 启用、空态或对话框 |
  | --- | --- | --- |
  | 项目列表 | `搜索项目`，`名称 / 数据集数 / 测试集数 / 更新时间 / 操作`，`查看`，`＋ 新建项目` | 名称空时创建禁用；`项目名称 / 说明（可选） / 取消 / 创建项目`；“没有符合条件的项目” |
  | 项目侧栏 | `当前项目`、项目名、关系线缩进的 `数据集 / 测试集` | 当前入口高亮；切换项目回对应列表 |
  | 数据集列表 | `搜索数据集`，`名称 / 类型 / 文件数 / 记录数 / 状态 / 更新时间 / 操作`，`查看 / 上传文件 / ＋ 新建数据集` | 名称空时创建禁用；`数据集名称 / 说明（可选） / 取消 / 创建数据集`；“没有符合条件的数据集” |
  | 文件页 | `文件 N / 全部记录 N`，`搜索文件`，`名称 / 格式 / 大小 / 记录数 / 上传时间 / 状态 / 操作`，`移动 / 查看` | 无其他数据集时移动禁用；`目标数据集 / 取消 / 移动`；“没有匹配的文件” |
  | 全部记录 | `文件 N / 全部记录 N`，`搜索问题、预测输出或 Metadata`，`序号 / 来源文件 / 问题 / 预测输出 / Metadata` | 编号打开完整记录；原始内容只读并可“返回统一记录”；“没有匹配的记录” |
  | 上传 | `选择文件 / 保存到`，`解析与浏览`，原始表头到 `问题 / 预测输出 / Metadata`，`取消 / 上一步 / 下一步 / 确认上传` | 未选文件或缺映射时后续按钮禁用；确认前不保存；错误可恢复 |
  | 测试集列表和创建 | `搜索测试集`，`名称 / 当前版本 / 记录数 / 来源 / 状态 / 更新时间 / 操作`，`查看 / 回收站 / ＋ 新建测试集`；`选择资料 / 选择记录 / 编辑并创建 v1` | 未选择记录不能创建；编辑列为 `序号 / 问题 / 预测输出 / Metadata`；“没有符合条件的测试集” |
  | 版本与来源 | `查看来源与修改 / 下载 CSV / 下载数据与溯源 / 继续创建新版本`，`当前版本摘要`，`版本关系`；再 `逐条查看变化 / 全部 / 有变化 / 未变化 / 已修改 / 已新增 / 已移除 / 搜索记录或来源` | 当前节点“正在查看”；父路径高亮；灰虚线墓碑不能浏览/下载/派生；来源可“查看原始资料” |
  | 回收站 | 测试集/版本分支、版本数、移入时间，`恢复 / 永久删除` | 删除先确认；非叶版本整支回收；“回收站为空”；墓碑只保留关系和最小删除说明 |

- 排除项逐页复核：登录、成员/角色、项目或数据集重命名/删除、高级 parser、版本说明、Schema、默认版本、归档、Package/CLI、Langfuse、Job/Audit、lineage 图、证据编辑器和独立 Controlled Deletion 页面。

- 2026-09-07：正式路由表。`workspace.ts` 是除原始内容下载链接外的唯一当前 V3 调用方；`narrowed` 的 DTO 和输入仅覆盖冻结原型。

  | 方法与精确路径/模式 | 当前调用方 | 处置 | fixed-HEAD 验证 |
  | --- | --- | --- | --- |
  | `GET /api/session`、空 JSON `POST /api/session` | `workspace.ts:csrfToken` | reused，无凭据 bootstrap | 待固定 commit |
  | `GET, POST /api/projects`；`GET, POST /api/projects/:projectId/collections` | `workspace.ts:list/createProjects`、`list/createCollections` | narrowed | 待固定 commit |
  | `POST /pending-uploads`、`PUT /pending-uploads/:id/preview`、`DELETE /pending-upload-batches`、`POST /pending-upload-batches/confirm` | `workspace.ts:startPendingUpload`、`previewPendingUpload`、`cancelPendingUploadBatch`、`confirmPendingUploadBatch` | narrowed | 待固定 commit |
  | `GET /collections/:collectionId/assets`、`GET /collections/:collectionId/assets/:assetId`、`GET /collections/:collectionId/records`、`PATCH /assets/:assetId/collection` | `workspace.ts:list/getMaterialFile`、`listUnifiedRecords`、`moveMaterialFile` | narrowed | 待固定 commit |
  | `GET /assets/:assetId/download?view=raw` | 文件详情页只读链接 | reused，唯一保留直接资产子路径 | 待固定 commit |
  | `GET, POST /solo-test-sets`、`GET /solo-test-set-sources`、`GET /versions/:id`、`POST /versions/:id/derived-versions` | `workspace.ts:list/create/get/deriveSoloTestSetVersion` | narrowed | 待固定 commit |
  | `GET /versions/:id/provenance`、`GET /provenance/:changeId`、`GET /versions/:id/{data.csv,provenance.csv}` | `workspace.ts:getSoloVersionProvenance`、`getSoloVersionChange`、`soloVersionDownloadUrl` | narrowed | 待固定 commit |
  | `POST /solo-test-sets/:id/trash`、`POST /versions/:id/trash`、`GET /solo-test-set-trash`、`POST /solo-test-set-trash/:id/{restore,permanent-delete}`、`POST /versions/:id/tombstone` | `workspace.ts` trash/restore/permanent-delete/tombstone | narrowed | 待固定 commit |
  | `ANY /assets`、`/assets/:id`、`/assets/:id/{archive,attribution,attributions,audit,parse-attempts,records}`、`/parsed-views/**`、`/jobs/**`、`/drafts/**`、`/candidates/**`、`/test-sets/**`、`/versions/:id/{package,packages,deliveries,langfuse-csv}`、`/transformation-runs/**`、`/deliveries/**`、`/lineage/trace`、`/deletions/**` | 无当前调用方 | retired，公开为 `route_not_found` | 待固定 commit |

- 2026-09-08：Project Owner 已在固定 HEAD `4e316eb` 的 Ticket 27 checkpoint 完成浏览器验收并明确接受。该 checkpoint 的 Web 仅监听 `127.0.0.1:4207`；`GET /health` 返回 `{"status":"ok","git_sha":"4e316eb"}`，Web、Worker、PostgreSQL 与 MinIO 均为 healthy。前端 `typecheck`、`lint` 与 production build 通过；lint 保留 donor UI 文件既有的 6 条 Fast Refresh warning，无 error。`frontend-v1/` 相对冻结 donor 基线 `92b0113` 无 diff，`git diff --check 4f099b5..4e316eb` 通过。固定 HEAD Standards/Spec 复核 P0=0、P1=0。未重跑历史全仓测试或性能 Spike，因为本次是正式 V3 切换的最终 UI 对齐修复，以上检查覆盖了受影响的 Web seam。
