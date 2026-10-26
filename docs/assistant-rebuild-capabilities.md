# 项目助手重建：人工操作与能力覆盖清单

- 核对日期：2026-10-26。
- 代码基线：`0b296e67a751e26379719d156381c2c36283c969`。
- 重建工作树：`/home/bistu/EvalBase/.worktrees/assistant-rebuild`；分支：`codex/assistant-rebuild`。
- 范围：正式 frontend-v3 可执行的人工操作、对应业务接口、权限和确认要求、旧助手覆盖缺口。不是仅按旧工具反推需求，也不把历史 API 当作现有页面功能。
- 性质：开发前盘点与接入建议，不表示缺口已实现，不替代现有业务合同，不决定新 Harness 的代码结构。
- 用户目标：助手能够在当前用户权限内，操作项目中人工能够操作的行为。文件选择、凭据输入、固定确认和下载可通过页面协作完成；不意味着模型可绕过权限或代用户批准。
- 本次只检查代码和文档，不运行模型、不修改业务代码、不部署、不修改验收数据和旧预算、不重跑旧测试。

## 1. 阅读方式

权限缩写：**管**＝全局管理员；**编**＝当前项目编辑成员；**看**＝当前项目查看成员；**本人**＝已登录账号自己的资料或会话。管理员具有所有项目权限；不把旧代码的 owner 当作新增产品角色。

旧覆盖：**有**＝已有业务工具入口，但受其来源、范围和任务限制，不代表稳定性验收通过；**部分**＝只覆盖部分场景；**无**＝十五个旧业务工具未暴露；**页面**＝前端或专用控制 API 已提供，但不是模型业务工具。

确认原则：

- **直接**：普通查询、预览和用户明确要求的可撤销修改不重复询问。
- **固定确认**：明确对象、范围、目标及修订后由用户点击；模型准备提案，不能替用户确认。沿用上传、采用、发布的现有边界。
- **删除确认**：保留现有影响说明；永久删除和中间版本内容删除还须用户输入名称或版本号。
- **原生输入**：文件选择、密码、API key 经受控表单；模型只获取授权文件句柄或非敏感回执。
- 成员管理等页面目前直接提交的动作会如实标出；新增助手入口建议一次明确对象的确认，不增加多层审批。

### 接口缩写

新助手可调用这些 HTTP 入口背后的共用业务服务，不要求服务端再绕一次 HTTP。项目和操作者来自认证上下文，不能由模型参数授予。

| 缩写 | 实际路径 |
| --- | --- |
| P | `/api/projects/:projectId` |
| D | `P/collaborative-drafts/:draftId` |
| V | `P/solo-test-sets/:testSetId/versions/:versionId` |
| T | `P/processing-tasks/:taskId` |
| R | `P/processing-runs/:runId` |
| A | `P/assistant` |
| C | `A/sessions/:sessionId` |

部分 processing 路由形参仍写成 runId，但 processing-tasks 路径承载的是处理任务身份。助手会话、助手任务、处理任务、处理轮次、交付项、草稿、版本不能混用 ID。

## 2. 逐页操作清单

### 2.1 项目入口与导航

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| P01 | 查询、搜索、分页查看可访问项目 | GET /api/projects；name/limit/offset | 本人 | 直接；只返回可访问项目 | 无；query_project 仅当前项目 |
| P02 | 创建项目；名称、描述 | POST /api/projects | 管 | 明确创建后直接；返回真实项目链接 | 无 |
| P03 | 查看当前项目和权限 | GET P、GET P/access | 管/编/看 | 直接；服务端计算权限 | 部分；query_project |
| P04 | 切换项目、打开业务页面和设置 | 路由导航、项目选择器 | 按目标页面权限 | 页面切换不得静默改变执行中任务的项目 | 页面 |
| P05 | 将当前对象和勾选范围交给助手 | assistant-input-context；sourceKind/sourceId/selectionToken；发送 context.inputSelection | 按对象权限 | 绑定记录 ID 与来源修订；失效时重选，不能默认全量 | 页面；已有范围交接 |

证据：[项目入口](../frontend-v3/src/routes/index.tsx)、[权限钩子](../frontend-v3/src/hooks/use-project-access.ts)、[服务端授权](../src/security/project-access.ts)。

### 2.2 原始数据：集合、上传、文件与字段整理

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| M01 | 查询集合；名称、类型、内容状态、更新时间、分页 | GET P/collections | 管/编/看 | 直接；保留“未整理”收纳区语义 | 无；query_project 只列文件 |
| M02 | 创建原始数据集合；名称、描述 | POST P/collections | 管/编 | 直接；不与创建测试集混淆 | 无 |
| M03 | 查询集合文件和文件详情 | GET P/collections/:collectionId/assets；其下 /:assetId | 管/编/看 | 直接；分页查询 | 部分；query_project(files) |
| M04 | 查看原始文件内容预览 | GET P/assets/:assetId/download?view=raw；页面预览前 1MB | 管/编/看 | 明确截断范围，不声称读完整个文件 | 无 |
| M05 | 浏览、搜索统一记录，查看单条全文，切换密度 | GET P/collections/:collectionId/records；文件下 /records/:ordinal；密度为前端状态 | 管/编/看 | 直接；列表预览与单条全文分开 | 部分；read_records 是有界预览 |
| M06 | 选本地文件并开始待确认上传 | POST P/pending-uploads；文件字节、x-file-name、幂等键 | 管/编 | 原生文件选择；暂存不等于已入库 | 无 |
| M07 | 配置问题、期望输出、Metadata 映射并预览 | PUT P/pending-uploads/:id/preview；mapping | 管/编 | 直接预览；不能伪造列或绕过解析检查 | 无 |
| M08 | 确认上传：按映射保存或只存原件 | POST P/pending-upload-batches/confirm；collectionId/pendingUploadIds/mode，幂等键 | 管/编 | 固定确认文件、集合和 mapped/raw 模式 | 无 |
| M09 | 取消未确认上传 | DELETE P/pending-upload-batches；pendingUploadIds | 管/编 | 明确取消后直接；不删除已确认文件 | 无 |
| M10 | 给已保存但未整理的文件补充映射 | GET P/assets/:assetId/mapping；POST .../preview；PUT .../mapping，parsedViewId/expectedRevision/mapping | 读管/编/看；改管/编 | 先预览再保存；当前只支持首次整理，不承诺反复重映射 | 无 |
| M11 | 移动文件到同项目另一集合 | PATCH P/assets/:assetId/collection；collectionId | 管/编 | 当前选目标后点击移动；不改变正文 | 无 |
| M12 | 从文件进入处理或助手 | 携带 assetId 的导航；后续见 W03/P05 | 管/编 | 打开页面不等于已提交任务 | 部分 |

保留现有 CSV/JSON/JSONL 解析、容量、映射和来源身份。原始字节不可变，清洗/改写生成派生结果。不额外加入网页抓取、Hugging Face 在线下载、任意路径读取或文件删除。

证据：[集合列表](../frontend-v3/src/routes/projects.$projectId.datasets.tsx)、[集合详情](../frontend-v3/src/routes/projects.$projectId.datasets.$collectionId.tsx)、[文件详情](../frontend-v3/src/routes/projects.$projectId.datasets.$collectionId.files.$assetId.tsx)、[上传组件](../frontend-v3/src/components/confirmed-upload-dialog.tsx)、[字段整理](../frontend-v3/src/components/material-preparation.tsx)、[客户端](../frontend-v3/src/services/workspace.ts)、[映射服务](../src/server/modules/material-mapping.ts)。

### 2.3 测试集列表与草稿

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| D01 | 搜索、全部/草稿/已发布筛选、分页 | GET P/solo-test-sets 与 GET P/collaborative-drafts，前端组合 | 正式内容管/编/看；草稿管/编 | 草稿筛选只含未发布新建测试集，派生草稿在版本页 | 部分；query_project 分类型查 |
| D02 | 创建新草稿 | POST P/collaborative-drafts；空 parent | 管/编 | 明确创建后直接；返回真实 ID | 有；create_draft |
| D03 | 基于正式版本创建/继续共享草稿 | 同上；testSetId/parentVersionId；GET 草稿列表 | 管/编 | 复用同父版本活跃草稿 | 有；create_draft |
| D04 | 查看草稿、搜索分页、展开记录与来源 | GET D；limit/offset/search；来源组件 | 管/编 | 同名对象绑定具体 ID | 部分；read_records/query_project |
| D05 | 修改草稿名称、用途，离焦保存 | PATCH D；field/value/expectedFieldRevision | 管/编 | 明确修改后直接；以回执为已保存依据 | 无；初始命名不等于编辑已有草稿 |
| D06 | 手动添加记录；问题、期望输出、Metadata 或真实来源 | POST D/records | 管/编 | 直接；与模型生成区分 | 无 |
| D07 | 编辑单条问题、期望输出、Metadata | PATCH D/records/:recordId；field/value/expectedFieldRevision | 管/编 | 只改指定字段，不全行覆盖并发修改 | 无；submit_processing 不等价 |
| D08 | 删除草稿记录 | DELETE D/records/:recordId；expectedRowRevision | 管/编 | 当前有移除确认；显示准确记录及影响 | 无 |
| D09 | 冲突时取服务端值或保留输入；被删记录另存为新记录 | 重读 D；人工选择后 PATCH；另存 POST D/records | 管/编 | 冲突有歧义由用户选择，不自动提修订覆盖 | 页面 |
| D10 | 退出/切换记录/分页前提交输入；失败重试 | 前端保存协调与 PATCH | 管/编 | 助手接手前同步未保存输入；异常关闭不保证保存 | 页面 |
| D11 | 删除未发布草稿 | DELETE D | 管/编 | 删除确认；未发布修改不可恢复，正式版本保留 | 无 |
| D12 | 发布新测试集或派生版本 | POST D/publish；revision | 管/编 | 固定发布确认；先保存，再冻结修订 | 有；request_publish 只准备确认 |
| D13 | 从草稿进入处理 | 带 draftId 的导航；提交见 W03 | 管/编 | 锁定来源和保存目标，回原草稿见 W13 | 部分 |

证据：[测试集列表](../frontend-v3/src/routes/projects.$projectId.test-sets.tsx)、[草稿工作区](../frontend-v3/src/routes/projects.$projectId.test-sets.drafts.$draftId.tsx)、[草稿客户端](../frontend-v3/src/services/drafts.ts)、[草稿服务](../src/server/modules/drafts.ts)。

### 2.4 从原始数据选择记录到草稿

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| S01 | 搜索、选文件，本页/全部搜索结果/取消 | GET P/collaborative-draft-source-files；本地选中集 | 管/编 | 最多 5 文件；批量和单选均检查 | 页面；preview_selection 接真实 assetIds |
| S02 | 条件筛选，全部匹配或随机数量/比例，生成预览 | POST D/selection-previews；assetIds/conditions/method/mode/value/seed | 管/编 | 直接预览；沿用 AND、比例取整和固定种子规则 | 有；preview_selection |
| S03 | 分页看预览、排除/补选、恢复初选、换一批 | POST .../:previewId/records；本地选择；新 seed 创建新预览 | 管/编 | 只在冻结候选内调整；配置改变使旧预览失效 | 部分 |
| S04 | 确认将所选记录加入草稿 | POST .../:previewId/apply；selectedIds/expectedRevision | 管/编 | 固定确认；来源去重、容量、原子提交 | 有；request_selection_apply |
| S05 | 查看选取历史与已选来源 | GET D/selection-history、GET D/selected-sources；正式版本同类历史入口 | 草稿管/编；正式管/编/看 | 直接；展示真实规则、来源和回执 | 无完整历史工具 |

兼容入口 POST D/source-selection 接受 assetIds、ordinals、排除、add/remove 和行修订；不能把它的即时查询当作向用户展示过的冻结预览，也不应再建设第二套选择语义。

证据：[选择组件](../frontend-v3/src/components/data-selection.tsx)、[客户端](../frontend-v3/src/services/selection.ts)、[服务](../src/server/modules/selection.ts)、[历史](../frontend-v3/src/components/selection-history.tsx)。

### 2.5 正式版本、来源、下载和回收站

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| V01 | 版本图、版本切换、摘要 | GET V | 管/编/看 | 关系只读，不支持合并或改挂父版本 | 部分；query_project |
| V02 | 正式记录搜索分页、单条全文、Metadata | GET V/records、GET V/records/:ordinal | 管/编/看 | 正式正文不可修改 | 部分；read_records |
| V03 | 来源、修改明细、选取历史、处理关联 | GET V/provenance、其下 /:changeId、GET V/selection-history | 管/编/看；处理详情另需写权限 | 链接继续鉴权；历史事实与当前名称分开 | 无完整工具 |
| V04 | 下载 CSV，或数据与溯源 ZIP | GET V/data.csv、GET V/provenance.csv；浏览器 fflate 打包 | 管/编/看 | 明确下载后返回受权下载动作；不暴露私有存储路径 | 页面 |
| V05 | 整个测试集移入回收站 | POST P/solo-test-sets/:testSetId/trash | 管 | 删除确认；说明版本及相关草稿影响 | 无 |
| V06 | 末端版本或版本及后代分支移入回收站 | POST V/trash；必要时 includeDescendants=true | 管 | 显示版本和后代数，不能扩为整个测试集 | 无 |
| V07 | 删除中间版本内容、保留关系节点 | POST V/tombstone；confirmation=版本号 | 管 | 用户输入版本号确认，不用删除分支替代 | 无 |
| V08 | 看回收站、恢复条目 | GET P/solo-test-set-trash；POST .../:entryId/restore | 页面仅管；读取 API 差异见 §5 | 恢复目前无额外二次弹窗；仍检查依赖 | 无 |
| V09 | 永久删除回收站条目 | POST P/solo-test-set-trash/:entryId/permanent-delete；confirmation | 管 | 用户输入名称/版本号，确认不可恢复影响 | 无；旧合同禁止 |

证据：[版本页面](../frontend-v3/src/routes/projects.$projectId.test-sets.$testSetId.tsx)、[回收站页面](../frontend-v3/src/routes/projects.$projectId.test-sets.tsx)、[版本服务](../src/server/modules/versions.ts)、[删除服务](../src/server/modules/deletion.ts)。

### 2.6 数据处理：输入、执行、轮次和保存

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| W01 | 任务列表、搜索、状态筛选、分页、刷新 | GET P/processing-tasks | 管/编 | 查看者不能读未发布处理结果 | 无；read_processing 需已知 runId |
| W02 | 选文件/草稿/版本，搜索/Metadata 筛选，勾本页/全部匹配/只看已选 | POST P/processing-inputs；继续轮次用 POST T/input；前端选择 | 管/编 | 预览直接；记录 ID、来源、修订一起冻结 | 部分；read_records 和范围交接 |
| W03 | 清洗/改写/扩充；范围、要求、字段策略、Metadata 键、扩充数量 | POST P/processing-runs；source.recordIds/options、幂等键 | 管/编 | 明确执行后提交；受预算和容量限制，不逐步重复确认 | 有；submit_processing |
| W04 | 状态、当前成果、错误、数量/重复/空值/缺失/字段保护检查 | GET T、GET R/status、GET R/review | 管/编 | 结构检查不等于人工内容审核通过 | 有；read_processing 部分展示 |
| W05 | 结果搜索、只看变化/需核对/重复；全文、Metadata、来源和处理过程 | GET T 分页筛选；来源组件 | 管/编 | 批次参考资料不冒充逐条精确生成依据 | 部分；read_processing 有界预览 |
| W06 | 勾本页/全部匹配/改写未生效记录，清空选择 | 前端结果 ID 集；用于后续处理/保存 | 管/编 | 区分当前页、筛选范围、整个成果 | 部分；select_candidates 和候选交接 |
| W07 | 预览重复组、排除重复、恢复排除 | POST T/deduplication；resultIds；应用/恢复带动作和 expectedRevision | 管/编 | 先看重复组再排除；只改候选、不删原件 | 部分；旧工具不完整覆盖任务排除恢复 |
| W08 | 同一任务内继续处理当前所选未保存成果 | POST T/rounds；mode=continue/resultIds/options/expectedRevision，幂等键 | 管/编 | 未选成果保留；新增轮次不伪造独立任务 | 部分；refine_candidates 仅助手未采用候选 |
| W09 | 沿上轮完整冻结输入重新处理 | POST T/rounds；mode=rerun/options/expectedRevision | 管/编 | 区分重试失败部分；读取冻结输入，受授权工作量限制 | 无完整对应工具 |
| W10 | 历史轮次、历史要求/输入/结果 | GET T/history、GET R | 管/编 | 历史只读，保存和继续针对当前成果 | 无完整轮次工具 |
| W11 | 取消运行、重试失败部分 | POST R/cancel、POST R/retry | 管/编 | 明确请求后执行；保留成功批次与结果 | 部分；retry_processing；助手停止不是任意任务取消 |
| W12 | 补齐未完成部分/实际缺额 | POST T/rounds；mode=complete/expectedRevision，幂等键 | 管/编 | 服务端允许且额度有效；不能开新任务绕过上限 | 部分；恢复能力并非通用工具 |
| W13 | 保存回原草稿；清洗/改写更新对应行，扩充追加 | POST T/accept；resultIds、target.kind=draft/id/expectedRevision、task revision、幂等键 | 管/编 | 固定确认；同字段冲突不能覆盖或改写到其他草稿 | 有；request_processing_apply，仍须核对 task/run 适配 |
| W14 | 另存原始数据、新草稿或加入已有草稿 | 同上；target.kind=asset/newDraft/draft；名称或草稿 ID | 管/编 | 固定确认；名称、目标、数量、回执链接一致 | 有；request_processing_apply |
| W15 | 保存响应不明时核对回执、重试原操作 | 同一 accept 请求、同一幂等键、结果刷新 | 管/编 | 不猜成功、不另起操作键重复采用 | 页面及领域幂等 |
| W16 | 基于已保存草稿继续处理 | POST T/input 与 POST T/rounds；mode=saved/options/expectedRevision，幂等键 | 管/编 | 仅在 canContinueSaved 时开放，读取真实草稿已保存范围，不把旧候选当当前正文 | 部分；submit_processing 能处理草稿，但无完整 saved 轮次适配 |

清洗/改写是一条输入对应一条候选，扩充产生新增记录；字段策略不授予修改原始文件的权利。精确去重不等于语义去重。重建复用处理任务和轮次，不再维护同义业务状态机。

证据：[处理页面](../frontend-v3/src/routes/projects.$projectId.processing.tsx)、[来源选择](../frontend-v3/src/components/processing-source-picker.tsx)、[来源展示](../frontend-v3/src/components/processing-review.tsx)、[处理路由](../src/server/modules/processing.ts)、[任务业务](../src/processing/tasks.ts)、[采用业务](../src/processing/accept.ts)。

### 2.7 项目助手自身

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| A01 | 新建/搜索/分页/切换本人会话，查消息和状态 | POST/GET A/sessions；GET C?view=status/messages | 本人且项目可读；正文按角色过滤 | 不读取其他人的私人会话 | 页面 |
| A02 | 会话改名 | PATCH C；title | 本人 | 直接；会话名、任务名、交付名、草稿名不同 | 页面 |
| A03 | 删除会话 | DELETE C | 本人 | 删除确认；删除消息/背景/未确认操作，停止任务，已创建业务资产保留 | 页面 |
| A04 | 上传 PDF/MD/TXT 背景、看片段和引用 | POST C/background-documents；fileName/contentBase64；GET .../:documentId?from&limit | 本人且管/编 | 原生上传；5 文件、合计 10MB；不是测试记录资产 | 页面上传；read_background 读取 |
| A05 | 删除背景文档 | DELETE C/background-documents/:documentId | 本人且管/编 | 当前有确认；保留关联计划、确认和历史正文清理规则 | 页面 |
| A06 | 普通提示查询、规划、改要求、执行；选择来源 | POST C/turns；message/context/expectedTaskRevision/operation、幂等键 | 查询项目可读；写任务管/编 | 只规划不执行；明确执行不重复问；真正有歧义才澄清 | 有；旧循环/plan_task |
| A07 | 背景驱动从零生成、多交付、分类和数量要求 | 旧 generate_candidates 接生成业务和 Worker，不是有输入的处理表单 | 本人且管/编 | 明确执行后有界生成；不用伪造种子；采用发布另确认 | 有；generate_candidates |
| A08 | 整任务候选审核/筛选/勾选、局部改写、配额选取和精确去重 | GET C/candidates；turns.candidates；复用处理结果 | 本人且管/编 | 范围固定；不扩大部分选择 | 有/部分；select_candidates/refine_candidates |
| A09 | 确认/拒绝选取、采用、发布提案 | POST A/proposals/:proposalId/confirm 或 /reject | 本人且管/编 | 用户点击当前有效卡；模型不能自行确认 | 页面＋三个 request_* 工具 |
| A10 | 暂停/停止、查询、继续、按方案执行、重试未完成步骤 | POST C/turns 受控操作；POST C/stop、POST C/retry | 本人且管/编 | 暂停优先生效；继续不加预算、不重复成功业务 | 页面＋旧运行时 |
| A11 | 查历史任务、恢复指定任务 | GET C/tasks/:taskId；turns.restoreTaskId | 本人且符合当前对象权限 | 查看不改活动任务；恢复保留原身份、修订、预算 | 页面＋旧运行时 |
| A12 | 查看额度、同意有上限继续/修复额度 | POST C/grant；offerId/purpose/expectedTaskRevision/accept、幂等键 | 本人且管/编 | 用户确认服务端有效 offer；模型不自批，旧消耗保留 | 页面＋控制 API |
| A13 | 操作记录、诊断、产物链接、跳转工作区 | 状态/消息回执与受权导航 | 本人；目标再次鉴权 | 区分已提交、已生成、已采用、已发布 | 页面 |

保留的是这些用户能力，不要求搬回旧 plan_task 大合同、多层自研修复或旧自动续步算法。新 Harness 可替换编排实现，但不能丢失暂停、恢复、历史证据与额度控制。

证据：[助手组件](../frontend-v3/src/components/project-assistant.tsx)、[会话管理](../frontend-v3/src/components/assistant-session-actions.tsx)、[背景](../frontend-v3/src/components/assistant-background.tsx)、[额度](../frontend-v3/src/components/assistant-budget.tsx)、[任务历史](../frontend-v3/src/components/assistant-task-history.tsx)、[候选](../frontend-v3/src/components/assistant-candidates.tsx)、[路由](../src/server/modules/assistant.ts)、[旧工具](../src/assistant/agent.ts)。

### 2.8 设置、账号和成员

| 编号 | 人工操作与关键输入 | 当前接口或前端动作 | 权限 | 确认与接入要求 | 旧覆盖 |
| --- | --- | --- | --- | --- | --- |
| U01 | 首次初始化、注册、登录 | GET /api/installation；POST /api/installation/administrator、/api/accounts、/api/session | 未登录；初始化仅空实例 | 原生账号表单；不是登录后助手的提权工具 | 页面 |
| U02 | 查本人资料、改名称/头像颜色 | GET/PATCH /api/me；displayName/avatarColor | 本人 | 直接；不能借此改邮箱、密码或角色 | 无 |
| U03 | 登出 | DELETE /api/session | 本人 | 明确登出后执行，停止当前页面授权交互 | 页面 |
| U04 | 查邀请、接受邀请 | GET /api/me/invitations；POST .../:id/accept | 接收本人 | 明确接受即可；不能代别人接受 | 无 |
| U05 | 查项目成员 | GET P/members | 管/编/看 | 只返回本项目可见资料 | 无 |
| U06 | 看邀请记录、邀请已注册用户 | GET/POST P/invitations；email/role=editor或viewer | 管 | 页面表单直接提交；助手建议一次目标明确的邀请确认，不另发邮件 | 无；旧合同排除 |
| U07 | 撤销邀请 | DELETE P/invitations/:id | 管 | 当前按钮直接提交；助手锁定接收人后确认一次 | 无 |
| U08 | 修改成员角色 | PATCH P/members/:id；role | 管 | 当前下拉直接提交；助手确认成员、项目、原/新角色 | 无；旧合同排除 |
| U09 | 移除成员 | DELETE P/members/:id | 管 | 当前按钮直接提交；助手确认成员与访问影响 | 无；旧合同排除 |
| U10 | 查项目可用模型名称和状态 | GET P/model-connection | 管/编/看 | 不返回 key、密文或认证头 | 无 |
| U11 | 管理员查/改模型连接、预设/自定义模型、端点、启停、换 key | GET/PUT /api/settings/model-connection；revision/name/endpoint/model/apiKey/enabled | 管 | 非敏感配置可准备；key 原生输入，保存前确认，不回显旧 key | 无 |
| U12 | 测试已保存模型连接 | POST /api/settings/model-connection/test；revision | 管 | 明确测试后执行；先保存再测，会产生受限实际请求 | 无 |

证据：[设置页](../frontend-v3/src/routes/settings.tsx)、[账号入口](../frontend-v3/src/components/account-gate.tsx)、[账号客户端](../frontend-v3/src/services/account.ts)、[账号服务](../src/server/modules/accounts.ts)、[模型配置](../frontend-v3/src/components/model-connection-settings.tsx)。

## 3. 十五个旧业务工具与复用边界

| 工具 | 可保留业务能力 | 不能据此认为已覆盖 |
| --- | --- | --- |
| plan_task | 要求、交付目标、控制意图的持久化需求 | 旧参数大合同、计划编译和多层纠错不是重建前提 |
| read_background | 授权片段、定义、真实引用 | 上传/删除、理解整份文档，文档内容不能授予权限 |
| query_project | 当前项目文件、测试集、版本、草稿查询 | 项目列表、集合、处理任务、成员、回收站全量能力 |
| read_records | 记录查询、筛选、部分统计 | 单条完整原文、所有来源与修改、任意聚合、编辑草稿 |
| create_draft | 新建、派生、复用草稿 | 已有草稿改名/用途、手动记录增删改、删除草稿 |
| preview_selection | 原始文件固定筛选/随机选取 | 全部人工调整、历史查询 |
| generate_candidates | 背景驱动从零生成 | 不能混用多交付身份，不能把从零生成降成有种子扩充 |
| submit_processing | 有输入的清洗、改写、扩充 | 整理映射、修改原文件、完整任务轮次管理 |
| select_candidates | 筛选、分组配额、精确去重、固定范围 | 完整任务排除恢复和 UI 勾选能力 |
| refine_candidates | 当前未采用候选局部改写 | 已保存草稿编辑、增加或补齐数量 |
| retry_processing | 合法重试失败部分 | 重跑成功部分、自行补额度 |
| read_processing | 状态、统计、候选预览 | 完整任务列表、轮次历史和详情 |
| request_selection_apply | 准备选择采用确认 | 不能自行批准，仍复检修订 |
| request_processing_apply | 准备保存到派生资产/新草稿/已有草稿的确认 | 不能自批；目标和结果身份必须对应当前任务 |
| request_publish | 准备草稿发布确认 | 不等于已经发布，完成以真实回执为准 |

需要补齐的是业务可操作面，并分开业务工具、控制操作与 UI 协作。不是每个按钮一个工具，也不是把所有操作塞回一个规划工具。新框架不会自动补齐上传、成员管理、字段编辑等产品能力。

## 4. 跨页面接入约束

1. **同一业务服务和授权。** 页面与助手共用领域函数；对象归属、角色、撤权、确认有效性在服务端判断。过宽旧接口不能成为扩大助手权限的依据。
2. **对象、范围和目标独立。** page/source、所选记录、来源修订、处理 task/run、交付、保存目标分别保存。当前页、匹配总数、全部成果、已选范围不能混同。
3. **接手前同步未保存输入。** 页面 flush 成功才切换、执行或发布；字段/行修订冲突不自动覆盖。助手不能只看服务端旧快照而丢掉用户本地输入。
4. **必要确认一次到位。** 采用、发布、删除、敏感管理、额度等展示确定影响后确认。确认绑定用户、目标、范围与修订；过期重新准备，不能重放旧批准。
5. **以回执认定完成。** 已排队、已生成、已采用、已发布分开；未知结果先核对同一幂等回执。名称、对象和保存链接从同一回执产生。
6. **恢复保留工作与预算。** 暂停使旧执行令牌失效；查询不执行；继续只做未完成部分。换框架不清零、重算旧预算，不重跑成功结果。
7. **前端协作有明确边界。** 上传、下载、登录、密钥、未提交输入、点击确认由页面协作；业务动作优先走工具。滚动、展开卡片、密度等不各建工作流。
8. **保留数据生命周期。** 正式版本不可变、处理溯源、回收/恢复、永久删除依赖传播、背景删除和历史清理继续有效；退出旧执行器不等于删旧表和触发器。

## 5. 发现的缺口与合同差异

| 优先级 | 发现 | 重建前应如何处理 |
| --- | --- | --- |
| P0 | 只有十五个旧业务工具，多个页面无入口 | 以本清单建立业务适配层，不能用换 Harness 代替功能覆盖 |
| P0 | 旧助手 PRD 排除成员管理、永久删除等，而新目标要覆盖人工行为 | 后续能力合同明确扩展合法操作，保留管理员、删除确认、原生凭据输入；本次不直接放开接口 |
| P0 | 草稿字段、处理 task/run、选取 preview、会话 proposal 各有不同身份/修订/幂等合同 | 输入类型分开，不能再用泛化 source/id 或 steps.input 装所有动作 |
| P0 | 回收站页面仅管理员可见，但 GET solo-test-set-trash 当前后端检查 read | 接入前统一读取权限；按页面和产品合同只向管理员提供，不能复制宽接口。本次未修改 |
| P1 | 集合/上传/映射/移动、草稿增删改、下载/来源、成员设置缺助手入口 | 复用已有业务函数，不加第二套数据库写法 |
| P1 | 多轮继续、原输入重跑、历史、排除恢复未与旧工具完整对应 | 复用处理任务与轮次，不能认为 refine_candidates 覆盖所有场景 |
| P1 | 本地输入、勾选、确认、文件依赖前端状态 | 定义桥接及过期处理；仅有聊天 HTTP 不代表能操作全项目 |
| P1 | 模型配置是实例级，任务是项目级 | 单独授权配置；key 不进模型上下文，变端点不能误用旧服务密钥 |
| P2 | 展示操作与业务命令容易混为“全能力” | 导航/呈现维持 UI 协作，不为每个视觉按钮建持久工作流 |

这是代码盘点，不是完整安全审计或动态验收。回收站差异来自前后端直接对照；“无覆盖”表示旧工具未暴露，不表示页面失效。

## 6. 不从历史接口自动扩大的范围

仓库留存 recipe、旧独占草稿、包产物、归档/资产删除等接口，以及当前路由不再调用的正式版本创建入口。接口存在不等于现在人能从正式页面操作，不能自动变成新助手工具。

当前正式页面未提供的项目改名/删除、集合改名/删除、已确认原始文件删除、正式版本原地编辑、版本合并/改挂、账号删除、邮箱/密码修改、注册后创建管理员，不伪装成当前能力；新增需另定义行为。

背景文档驱动从零生成、多交付规划、会话任务恢复等助手专属能力仍在 A 组保留，不能因普通处理表单没有按钮而在重建中丢失。

## 7. 后续覆盖验收口径

本次不运行以下验证，不重跑旧验收；这些是后续设计和票据的输入。

- 每个编号标明共用业务工具、前端桥接或原生人工步骤；未接入不能写为“已支持全项目操作”。多个编号可以复用一个适当的领域接口。
- 重点验证真实业务边界：合法输入、无权限、跨项目对象、修订变化、重复提交、未知结果恢复。共享校验共用测试，避免按按钮机械复制。
- 写操作核对准确修改对象、未选内容保留、回执与链接一致；恢复不能只测 helper。
- 证明模型不能代用户采用、发布、永久删除或追加额度，凭据不进提示词、工具结果和日志。
- 桥接覆盖真实勾选、未保存输入、文件选择、下载和失效确认；纯后端 Mock 不能替代。
- 保留旧数据/预算兼容证据；新执行器不直接消费不兼容旧检查点。普通提示端到端验证另设上限，记录首错和自动纠正。

## 8. 依据与本次检查记录

- [领域语言](../CONTEXT.md)：原始文件、统一记录、草稿、版本、来源。
- [v2 PRD](PRD-evalbase-v2.md)：账号、成员、权限、协作、发布、删除。
- [数据选取与助手 PRD](PRD-data-selection-and-assistant.md)：固定选择、映射、连接、处理和确认。
- [v2 架构](architecture/evalbase-v2-architecture.md)、[处理与助手架构](architecture/data-selection-and-assistant.md)：业务复用与存储责任。
- [账号授权 ADR](adr/0012-v2-account-and-project-authorization.md)、[协作发布 ADR](adr/0013-v2-shared-draft-publication.md)、[助手运行 ADR](adr/0014-project-agent-and-processing-runtime.md)：保留业务约束，运行时选型后续明确取代。

本次逐页对照 route/component、客户端请求、服务端模块与工具声明。历史文档实施状态不作为当前覆盖证明。源码证据固定于页首提交；部署版本及真实模型成功率未重测。文档完成后检查本文件相对链接、表格、围栏和编号，并运行仓库 docs:check。
