# 单人数据资料与测试集原型参考项目调研

| 项目     | 内容                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 调研日期 | 2026-08-31                                                                                                                                   |
| 调研目的 | 为 EvalBase Phase 1A 两页单人原型寻找可直接借鉴的资源浏览、统一记录预览、字段映射、表格编辑、不可变版本与轻量溯源模式                      |
| 目标体验 | 无登录/角色；一级导航仅“原始资料”和“测试集”；CSV、JSON、JSONL 统一浏览；从一个或多个资料选择记录；表格增删改；保存不可变新版本；直接下载 CSV |
| 资料范围 | 仅使用项目官方文档、官方 GitHub 仓库/源码、许可证和正式规范                                                                                  |
| 文档效力 | 研究证据，不修改或替代 PRD、Architecture、ADR、Implementation Spec、Ticket、Gate 或已确认原型行为                                            |

## 1. 执行结论

没有一个开源项目与 EvalBase 的单人工作流完全相同。最合适的做法不是引入其中一个产品，而是只吸收五类已经成熟的界面和信息表达：

1. 借 **Quilt** 的文件资源管理器、文件详情与小样本预览，完善“原始资料”列表和浏览页。
2. 借 **OpenRefine** 的“选择文件 → 解析配置 → 真实数据预览 → 确认创建”连续导入体验，以及简洁的操作历史表达。
3. 借 **Grist Core** 的字段映射、紧凑数据网格、单元格原位编辑、行级增删和修改差异预览，完善测试集编辑器。
4. 借 **Datasette** 的表格浏览、排序、筛选、分页、单条记录详情和直接 CSV 下载，完善只读浏览体验。
5. 借 **Frictionless** 的物理文件/逻辑记录分离和按行、按字段定位的校验报告，完善解析失败提示；它是数据合同参考，不是要复制的主界面。

这些模式必须装进现有的两个一级页面，不能据此新增“数据目录”“数据包”“流水线”“版本控制”或“治理中心”等入口。对当前 throwaway 原型最有价值的组合是：

```text
原始资料列表：Quilt
  → 上传、解析与预览：OpenRefine + Grist
  → 统一记录浏览：Datasette
  → 测试集表格编辑：Grist
  → 解析错误：Frictionless
  → 版本与来源：EvalBase 现有不可变版本模型，以简短时间线和来源摘要呈现
```

## 2. 筛选标准与项目清单

本轮只保留能直接回答当前原型问题的项目：

- 是否让单人用户不经培训就能找到文件、打开记录、上传资料和创建测试集；
- 是否支持在确认前查看真实数据，而不是只展示文件名或示意内容；
- 是否能用紧凑表格完成记录的查看、选择、增加、修改和删除；
- 是否能把版本、来源和错误留在次要层级，不阻塞主流程；
- 是否能避免登录、团队权限、云资源、通用数据治理和流水线概念占据页面。

| 项目                                                                                      | 开源许可         | 对当前原型的适配度 | 本轮定位                                                 |
| ----------------------------------------------------------------------------------------- | ---------------- | ------------------ | -------------------------------------------------------- |
| [Quilt](https://github.com/quiltdata/quilt)                                               | Apache-2.0       | 高                 | 原始资料资源管理器、文件详情、最小预览、不可变版本表达   |
| [OpenRefine](https://github.com/OpenRefine/OpenRefine)                                    | BSD-3-Clause     | 高                 | 导入预览、解析确认、统一表格探索、操作历史摘要           |
| [Grist Core](https://github.com/gristlabs/grist-core)                                     | Apache-2.0       | 高                 | 字段映射、记录选择、紧凑表格增删改、变更差异             |
| [Datasette](https://github.com/simonw/datasette)                                          | Apache-2.0       | 中高               | 只读记录浏览、筛选、分页、单条详情、直接 CSV 下载        |
| [Frictionless Framework / Standards](https://github.com/frictionlessdata/frictionless-py) | MIT（Framework） | 中                 | 物理/逻辑数据分离、字段描述、可定位解析/校验错误         |
| [DVC](https://github.com/iterative/dvc)                                                   | Apache-2.0       | 低（原型 UI）      | 本轮排除；只用于校验不可变版本和来源语义，不作为界面参考 |

许可证来自各官方仓库的 [Quilt LICENSE](https://github.com/quiltdata/quilt/blob/master/LICENSE)、[OpenRefine LICENSE](https://github.com/OpenRefine/OpenRefine/blob/master/LICENSE.txt)、[Grist Core LICENSE](https://github.com/gristlabs/grist-core/blob/main/LICENSE.txt)、[Datasette LICENSE](https://github.com/simonw/datasette/blob/main/LICENSE)、[Frictionless LICENSE](https://github.com/frictionlessdata/frictionless-py/blob/main/LICENSE.md) 和 [DVC LICENSE](https://github.com/iterative/dvc/blob/main/LICENSE)。本调研借鉴交互和信息组织，不表示可以忽略各项目对源码、图标、图片、名称和再分发的具体许可要求。

## 3. Quilt：原始资料资源管理器与版本详情

### 3.1 已验证能力

[Quilt 官方 Mental Model](https://docs.quilt.bio/mentalmodel)把 package 定义为具名、不可变、可版本化的相关文件集合；manifest 使用稳定的逻辑名称指向实际存储位置，并附带哈希和元数据。这个模型与 EvalBase 完全一致的部分是“用户看稳定名称，系统内部保存精确位置和完整性证据”，但 Quilt package 是文件集合，不是 EvalBase 的统一测试记录集合。

[Bucket Browsing 官方文档](https://docs.quilt.bio/quilt-platform-catalog-user/filebrowser)展示了典型文件资源管理器：文件列表、拖放或 `Add Files`、多选、从现有文件创建 package，以及 Bookmarks 暂存跨目录选择。它还把已归档、暂不可用的对象置灰并在详情中解释原因。

[Document Previews 官方文档](https://docs.quilt.bio/quilt-platform-catalog-user/preview)说明 Quilt 为 CSV、JSON、文本、Parquet、Excel 等多种文件提供预览，并尽量只流式读取生成预览所需的最小数据子集。

官方仓库 [Open Source and Enterprise](https://github.com/quiltdata/quilt#open-source-and-enterprise)明确区分：仓库提供开源 SDK、CLI、package 版本与部分 Catalog 代码，但完整托管搜索和可视化体验属于企业平台部署。因此，本文把 Catalog 文档视为产品交互的一手参考，不把所有平台能力声称为可直接采用的开源成品。

### 3.2 可直接借鉴到原型

- 原始资料首页继续使用文件图标、文件名、格式/大小、上传时间、简洁状态和明确进入箭头，不把哈希、对象键和解析作业 ID 放进默认列表。
- 保持当前已经确认的双重交互：点击整行只选中资料并更新右侧信息面板；点击行末箭头才进入统一记录浏览页。
- 右侧面板只展示识别文件和判断能否浏览所需的信息；原始位置、哈希、字段映射和解析详情通过次要入口展开。
- 文件浏览页首先展示统一记录表格，只读取当前页需要的记录；原始 CSV/JSON/JSONL 内容放在“查看原始内容”次要操作中。
- 无法预览时保留该资料，并在预览区给出“为什么不能浏览”和可执行修正，不用模糊的全局失败状态替代文件状态。
- 创建测试集时可借鉴临时多选托盘：页面持续显示“已选资料 N 份、记录 M 条”，但该选择只存在于当前创建流程，不建立全局 Bookmarks 页面。
- 测试集详情用简短版本时间线显示 `v3 当前版本 / v2 / v1`，每项提供打开和下载；内部内容哈希只在按需详情中出现。

### 3.3 绝不能照搬

- 不显示 S3 bucket、registry、logical/physical key、Raw/Staging/Production bucket 或 AWS IAM 概念。
- 不建立跨 bucket 工作流、全局 Bookmarks、组织级搜索、Dashboard、团队分享或丰富元数据表单。
- 不复制任意 HTML/JavaScript 文件预览；EvalBase 当前只需要 CSV、JSON、JSONL 的安全、统一记录预览。
- 不把 Quilt package 直接当作测试集模型。EvalBase 测试集的核心是统一记录、父版本和记录级来源，而不是任意文件集合。

## 4. OpenRefine：上传确认、数据探索与修改历史

### 4.1 已验证能力

[Starting a project 官方文档](https://openrefine.org/docs/manual/starting)说明 OpenRefine 从一个或多个已有文件创建本地项目，不修改原始数据源，而是复制输入并在自己的项目中保存编辑。选择文件后，用户先进入解析配置页，看到前 100 行和识别出的全部列；确认解析方式、编码和表头后才创建项目。多文件导入还会自动增加来源文件名或 URL 列。

[Exploring data](https://openrefine.org/docs/manual/exploring)与 [Facets](https://openrefine.org/docs/manual/facets)展示了记录表格、类型提示、排序、文本筛选、按值计数和匹配行/总行数。筛选仅改变当前视图，原始行号保持可见。

[Cell editing](https://openrefine.org/docs/manual/cellediting)支持单个单元格编辑，也支持把同一值的多个单元格统一修正。[History (Undo/Redo)](https://openrefine.org/docs/manual/running#history-undoredo)从项目创建开始记录每次数据修改，按顺序展示变化并可回到之前的状态。[Exporting](https://openrefine.org/docs/manual/exporting)支持把当前筛选结果或完整数据直接导出，并能先预览导出结果。

### 4.2 可直接借鉴到原型

- 上传弹窗固定为一个连续流程：选择文件后立即进入解析和真实记录预览，确认前不让资料出现在正式列表。
- 解析步骤保持“数据预览始终是主体，解析选项在旁边”的布局；用户改变编码、表头或字段映射时，预览立即更新。
- 预览顶部明确显示“当前展示 100 条 / 共 N 条”以及文件格式、编码和解析结果，避免让用户误以为预览就是全部数据。
- 原始资料和测试集的浏览页增加一个简单搜索框，以及至多一两个当前任务确实需要的筛选；持续显示“匹配 M 条 / 共 N 条”。
- 编辑新版本时可增加可折叠的“本次修改”摘要，按操作顺序显示“修改 3 条、增加 1 条、移除 2 条”；记录级细节仍放在来源详情中。
- 下载前仅在用户需要时显示格式、记录数和版本，随后直接下载；不建立独立交付管理流程。

### 4.3 绝不能照搬

- 不复制 GREL/Jython/Clojure 表达式、聚类、reconciliation、Wikidata、批量变换或任意自定义 exporter。
- 不把筛选侧栏扩展为大量 Facet 面板。当前原型最多需要名称搜索、状态或来源等少量高频筛选。
- 不采用 OpenRefine 的可回退可变项目作为正式版本模型；EvalBase 保存后必须形成新的不可变版本，不能重写旧版本。
- 不让“操作历史”成为第三个一级页面，也不向用户显示内部命令 JSON。

## 5. Grist Core：字段映射与紧凑表格编辑

### 5.1 已验证能力

[Grist Core 官方仓库](https://github.com/gristlabs/grist-core#readme)把 Grist 定义为关系型电子表格：列像数据库一样有名称和类型，记录又保持电子表格式的直接查看和编辑。仓库同时明确 `grist-core` 是 Apache-2.0 的 Community edition，并列出完整商业版本才有的附加能力。

[Importing more data 官方文档](https://support.getgrist.com/imports/)展示了与 EvalBase 很接近的导入对话框：CSV、JSON、Excel 等文件先进入预览；导入到已有表时，每个目标列通过 `Source Column` 下拉框选择来源列，也可以选择 `Skip`。更新已有记录时，预览用绿色表示新增值，用红色删除线和绿色组合表示旧值/新值，并让未变化记录保持普通样式。

[Card & Card List 官方文档](https://support.getgrist.com/widget-card/)说明单个 Card 可与 Table 联动，展示当前选中记录的详情。这为当前原型“列表选中只更新右侧信息面板，箭头才进入浏览页”的模式提供了直接参考。

### 5.2 可直接借鉴到原型

- 字段映射区使用一行一个目标字段的紧凑结构：左侧固定显示“问题 / 预测输出 / Metadata”，右侧下拉选择原文件表头，并在下方持续显示真实映射结果。
- 映射下拉中提供清楚的“不映射”，但确认前必须明确哪些目标字段是必填、哪些可为空；不静默丢弃会影响用户判断的原始列。
- “选择记录”和“编辑并创建”都采用同一套紧凑数据网格，而不是一条记录一张大卡片；保留勾选列、固定表头和分页。
- 编辑器允许单元格原位修改、底部新增空行、行级移除，并在表格上方持续显示增加/修改/移除计数。
- 用户主动打开“查看本次修改”时，用绿色表示新增内容、红色删除线表示旧内容；默认编辑网格保持干净。
- 当前右侧文件信息面板继续保留：行选择改变面板内容，进入箭头保持独立动作。

### 5.3 绝不能照搬

- 不复制公式系统、关系引用、Widget/Dashboard 构建器、自定义 Card 布局、图表和表单生成器。
- 不复制组织、工作区、分享、评论、访问规则、Webhook、自动化或 AI 助手。
- 不把可变电子表格文档当正式测试集版本；Grist 的编辑体验只用于生成下一份 EvalBase 不可变版本。
- 不增加列类型管理器或数据库设计界面。当前目标字段继续只有已确认的“问题、预测输出、Metadata”。

## 6. Datasette：只读表格浏览、记录详情与直接 CSV

### 6.1 已验证能力

[Datasette 官方仓库](https://github.com/simonw/datasette#readme)把产品定位为通过浏览器浏览和发布数据的工具。[Table 官方文档](https://docs.datasette.io/en/stable/pages.html#table)称表格页为 Datasette 的核心：用户可以排序、筛选、全文搜索和使用 facets；[Row](https://docs.datasette.io/en/stable/pages.html#row)为每条记录提供稳定详情 URL，并在表格中截断长文本、在详情页显示完整内容。

[Facets 官方文档](https://docs.datasette.io/en/stable/facets.html)以“常见值 + 计数”帮助用户进一步筛选表格。[JSON API Pagination](https://docs.datasette.io/en/stable/json_api.html#pagination)使用不透明的 next token 获取下一页。[CSV export](https://docs.datasette.io/en/stable/csv_export.html)让当前表格、视图或查询直接下载为 CSV，并使用分页流式返回完整匹配记录。

### 6.2 可直接借鉴到原型

- 原始资料和测试集的统一记录浏览使用同一种表格骨架：固定列标题、长文本截断、分页、记录总数和清楚的空状态。
- 点击长内容或记录编号打开轻量详情抽屉/弹窗，显示该条记录的完整“问题、预测输出、Metadata”，不迫使整张表无限增高。
- 搜索、排序和分页状态紧邻表格；任何筛选都持续显示“匹配 M 条 / 共 N 条”。
- “下载 CSV”直接位于测试集版本浏览页，默认下载当前指定版本的全部记录；如果未来允许下载筛选结果，必须明确写成“下载当前筛选的 M 条”。
- 数据量较大时保持服务端分页和流式下载语义，不因前端原型的内存 Mock 实现而形成浏览器整体加载合同。

### 6.3 绝不能照搬

- 不暴露 SQLite 数据库、表、SQL 查询编辑器、JSON API 参数或插件系统。
- 不把每种原始文件转成用户可见的数据库/表层级；CSV、JSON、JSONL 仍统一表现为“资料 → 记录”。
- 不复制任意 Facet、全文索引和自定义查询功能；没有明确用户任务支撑的筛选不进入原型。
- 不采用 Datasette 的数据库可变写入权限模型来代替 EvalBase 的新版本保存。

## 7. Frictionless：解析和校验错误的轻量表达

### 7.1 已验证能力

[Frictionless Framework 官方仓库](https://github.com/frictionlessdata/frictionless-py#readme)提供描述、抽取、校验和转换表格数据的统一接口，支持 CSV、JSON、SQL 等格式，并输出统一 validation report。官方示例把问题定位为 `row / field / code / message`，例如空表头、重复表头、缺少单元格或多余单元格。

[Data Resource 规范](https://specs.frictionlessdata.io/data-resource/)把一个文件或表描述为带 locator 和可选元数据的 resource；[Data Package 规范](https://specs.frictionlessdata.io/data-package/)把一组 resources 与 descriptor 组合成可交付集合。[Table Schema 规范](https://specs.frictionlessdata.io/table-schema/)明确区分磁盘上的物理表示与经过类型、结构和约束解释后的逻辑表示。

### 7.2 可直接借鉴到原型

- 原型文案明确区分“原始内容”和“统一记录”：原始文件保持原样，字段映射只影响浏览和测试集记录，不伪装成文件已被改写。
- 解析失败时用紧凑表格列出“记录位置、原始字段、问题、建议”，并允许用户点击错误跳到对应预览记录。
- 上传预览顶部显示错误摘要，例如“2 条无法解析、3 个字段未映射”，具体技术定位默认折叠。
- 对 CSV 空表头、重复表头、缺少/多余单元格，以及 JSON/JSONL 结构不一致，使用稳定、可理解的错误名称，而不是只显示异常堆栈。
- 测试集下载时可以附带轻量描述 CSV 或来源 CSV，但不要求用户理解 Data Package descriptor。

### 7.3 绝不能照搬

- 不在 UI 中引入 Resource、Package、Dialect、Schema Descriptor 等规范术语。
- 不让用户在上传前完整定义类型、约束、主键和许可证元数据；当前流程仍然是先解析和预览，再确认必要映射。
- 不在原型中建设通用数据质量规则编辑器、转换 pipeline 或格式插件市场。
- 不直接把 Frictionless Data Package 当 EvalBase 下载合同；当前已确认的直接测试集 CSV 和来源 CSV 保持不变。

## 8. 为什么本轮不采用 DVC

[DVC 官方仓库](https://github.com/iterative/dvc#readme)明确把 DVC 定义为命令行工具和 VS Code 扩展：大文件存放在外部 cache/remote，Git 保存轻量版本信息；`dvc.yaml` pipeline 连接代码、输入、命令和输出。它对“原始资料不被覆盖、每次结果有精确输入版本、稳定名称可取得指定版本”的工程语义很有价值。

但 DVC 不能直接回答当前原型的关键问题：如何上传并预览 CSV/JSON/JSONL、如何映射字段、如何选记录、如何在表格中增删改、如何让唯一用户直接下载。把 DVC 加入主参考会引入 Git commit、branch、remote、cache、pipeline 和 experiment 等当前用户不应理解的概念。

因此本轮决定：

- 保留 EvalBase 已有的不可变版本、父版本和来源链，不需要用 DVC 重新设计；
- 测试集详情只显示 `v3 / v2 / v1`、时间、来源资料数和增改删摘要；
- 不在原型中出现 commit、checkout、push、remote、DAG 或实验跟踪；
- DVC 仅作为后续工程实现审查时的版本语义参考，不作为当前页面或组件参考。

## 9. 对当前 throwaway 原型的优化清单

以下建议不改变现有流程和两页信息架构，只补足用户在当前原型中需要看清和操作顺畅的内容。

### 9.1 第一优先级：下一轮原型应补

| 当前区域     | 借鉴来源                    | 最小改动                                                                                    |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------- |
| 原始资料列表 | Quilt                       | 保持列表行选择与进入箭头分离；右侧面板补文件格式、记录数、上传时间和能否浏览，技术证据折叠  |
| 上传资料     | OpenRefine + Grist          | 选择文件后让真实数据预览始终占主体；解析/映射变化即时更新预览；确认前显示记录总数和错误摘要 |
| 字段映射     | Grist                       | 以“问题 / 预测输出 / Metadata → 原表头下拉框”逐行映射，并持续展示映射结果                   |
| 统一记录浏览 | Datasette                   | 增加固定表头、长文本展开、分页、匹配数/总数和简单搜索；CSV、JSON、JSONL 使用完全一致的表格  |
| 选择记录     | Grist                       | 按资料分组但共用紧凑表格；明确全选当前资料、已选资料数和记录数                              |
| 编辑并创建   | Grist                       | 单元格原位编辑、底部新增、行级移除；顶部持续显示增加/修改/移除计数                          |
| 测试集详情   | Quilt + EvalBase 现有模型 | 以简短版本时间线切换版本；每个版本提供打开、查看来源和下载 CSV                              |
| 解析错误     | Frictionless                | 显示错误摘要和可定位的“记录位置 / 字段 / 问题 / 建议”，不显示堆栈                           |

### 9.2 第二优先级：第一轮点击确认后再补

- 简单的名称搜索，以及最多一两个高频筛选；先验证用户确实需要，再增加 Facet。
- “查看本次修改”差异弹窗：绿色新增、红色删除线旧值，默认编辑界面不常驻差异颜色。
- 单条记录详情抽屉，用于查看长问题、预测输出、Metadata、来源资料和记录级变化。
- 下载确认只说明测试集名称、版本和记录数；直接下载 CSV，来源 CSV 作为同一详情页中的次要下载。

### 9.3 明确不增加

- 第三个一级页面或新的长期部署单元；
- 登录、成员、角色、协作、评论和分享；
- 数据目录、Package、Registry、Bucket、数据库或表管理；
- Git/DVC 术语、pipeline DAG、后台作业中心和通用治理表单；
- 公式、任意转换语言、SQL 编辑器、插件市场和 AI 助手；
- 责任人、许可状态、敏感级别等已经从日常上传流程移除的字段。

## 10. 一手资料索引

### Quilt

- [官方 GitHub 仓库](https://github.com/quiltdata/quilt)
- [Open Source and Enterprise](https://github.com/quiltdata/quilt#open-source-and-enterprise)
- [LICENSE](https://github.com/quiltdata/quilt/blob/master/LICENSE)
- [Mental Model](https://docs.quilt.bio/mentalmodel)
- [Bucket Browsing](https://docs.quilt.bio/quilt-platform-catalog-user/filebrowser)
- [Document Previews](https://docs.quilt.bio/quilt-platform-catalog-user/preview)

### OpenRefine

- [官方 GitHub 仓库](https://github.com/OpenRefine/OpenRefine)
- [LICENSE](https://github.com/OpenRefine/OpenRefine/blob/master/LICENSE.txt)
- [Starting a project](https://openrefine.org/docs/manual/starting)
- [Exploring data](https://openrefine.org/docs/manual/exploring)
- [Facets](https://openrefine.org/docs/manual/facets)
- [Cell editing](https://openrefine.org/docs/manual/cellediting)
- [History (Undo/Redo)](https://openrefine.org/docs/manual/running#history-undoredo)
- [Exporting](https://openrefine.org/docs/manual/exporting)

### Grist Core

- [官方 GitHub 仓库](https://github.com/gristlabs/grist-core)
- [LICENSE](https://github.com/gristlabs/grist-core/blob/main/LICENSE.txt)
- [Importing more data](https://support.getgrist.com/imports/)
- [Card & Card List](https://support.getgrist.com/widget-card/)

### Datasette

- [官方 GitHub 仓库](https://github.com/simonw/datasette)
- [LICENSE](https://github.com/simonw/datasette/blob/main/LICENSE)
- [Table and Row pages](https://docs.datasette.io/en/stable/pages.html)
- [Facets](https://docs.datasette.io/en/stable/facets.html)
- [JSON API Pagination](https://docs.datasette.io/en/stable/json_api.html#pagination)
- [CSV export](https://docs.datasette.io/en/stable/csv_export.html)

### Frictionless

- [Frictionless Framework 官方 GitHub 仓库](https://github.com/frictionlessdata/frictionless-py)
- [LICENSE](https://github.com/frictionlessdata/frictionless-py/blob/main/LICENSE.md)
- [Data Resource](https://specs.frictionlessdata.io/data-resource/)
- [Data Package](https://specs.frictionlessdata.io/data-package/)
- [Table Schema](https://specs.frictionlessdata.io/table-schema/)

### DVC（排除项）

- [官方 GitHub 仓库](https://github.com/iterative/dvc)
- [LICENSE](https://github.com/iterative/dvc/blob/main/LICENSE)
- [Versioning Data and Models](https://dvc.org/doc/example-scenarios/versioning-data-and-models)
- [Importing External Data](https://dvc.org/doc/user-guide/data-management/importing-external-data)
- [Data Registry](https://dvc.org/doc/example-scenarios/data-registry)
