# 资料集合与多文件管理模式调研

| 项目     | 内容                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 调研日期 | 2026-08-31                                                                                                                   |
| 调研问题 | “原始资料”是否应从单文件列表调整为“先创建原始资料集，再在其中上传多个文件”                                                   |
| 当前约束 | 单人使用；无登录/角色 UI；一级导航仍只有“原始资料”和“测试集”；CSV、JSON、JSONL 映射为统一记录；`frontend-v1/` 仅作视觉 donor |
| 资料范围 | 仅使用项目官方文档、官方仓库和当前仓库源码                                                                                   |
| 文档效力 | 研究证据与原型建议，不修改 PRD、Architecture、ADR、Spec 或正式产品行为                                                       |

## 1. 结论

建议采用一层很浅、可选的“资料集合 → 文件 → 统一记录”结构。它能解决不同领域、方向和批次的文件混在同一个列表中的问题，而且不需要增加新的一级页面。

> 术语说明：用户提出的“原始数据集/原始资料集”与当前 [`CONTEXT.md`](../../CONTEXT.md) 中明确避免的领域词汇冲突，也容易和正式“测试集”混淆。本文把拟议的新归类层暂称为“资料集合”；最终名称只有在 Project Owner 批准并同步权威文档后才能成为正式术语。

```text
原始资料（现有一级页面）
  └─ 资料集合，例如“金融问答”“医疗公开语料”“客服意图”
       ├─ train.csv
       ├─ supplement.jsonl
       └─ corrections.json
            └─ 映射后的统一记录：问题 / 预测输出 / Metadata
```

最适合 EvalBase 的组合不是照搬某一个系统，而是：

1. 用 **CKAN** 的 `dataset → resources` 关系作为最小领域骨架：一个有名称的集合包含任意多个文件。
2. 用 **Dataverse** 的多文件上传、文件表格/树形切换和单文件详情作为集合内部交互参考，但第一版只做平铺文件列表，不做任意嵌套目录。
3. 沿用 **Quilt** 的文件资源管理器、右侧信息面板和单文件预览方式。
4. 沿用 **frontend-v1** 的数据集列表、详情页和版本外壳；不能直接复用它的 Dataset 领域语义。
5. **Label Studio** 和 **FiftyOne** 只借鉴“容器内浏览统一任务/样本”的局部交互，不作为文件容器模型。

这项调整适合原型验证，但会改变正式产品中的对象关系。当前 PRD 明确要求上传入口先询问文件，因此资料集合不能成为上传前置条件：用户可以先建集合再上传，也必须可以直接上传到“未整理”并在之后归类。原型确认后，应先同步权威产品文档，再连接现有 API；不应只改前端后把新层级暗中塞进旧的单文件合同。

## 2. 排名

| 排名 | 项目                                                        | 与当前问题的适配度 | 最值得借鉴                                | 主要不适配                                          |
| ---: | ----------------------------------------------------------- | ------------------ | ----------------------------------------- | --------------------------------------------------- |
|    1 | [CKAN](https://github.com/ckan/ckan)                        | 高                 | 最简单的“数据集包含多个资源”关系          | 组织、许可、发布、插件和数据门户过重                |
|    2 | [Dataverse](https://github.com/IQSS/dataverse)              | 高                 | 多文件上传、文件表格/树形浏览、单文件预览 | 研究仓储元数据、权限、审查和发布流程过重            |
|    3 | [Quilt](https://github.com/quiltdata/quilt)                 | 中高               | 文件资源管理器、详情面板、类型预览        | S3、Bucket、IAM 和 Package 术语不适合单人产品       |
|    4 | [FiftyOne](https://github.com/voxel51/fiftyone)             | 中                 | 数据集内样本浏览、筛选、详情展开          | 主要面向图像/视频/3D 与机器学习样本，不是通用文件库 |
|    5 | [Label Studio](https://github.com/HumanSignal/label-studio) | 中低               | 项目内导入任务并统一查看                  | 容器持有任务而非原始文件，标注配置和存储概念过重    |

## 3. frontend-v1：可借外壳，不能照搬语义

### 3.1 当前实现实际是什么

`frontend-v1` 的 `Dataset` 是一个稳定容器，列表展示名称、默认版本、记录数和更新时间；详情页包含版本时间线和样本表格。`DatasetVersion` 持有 `samples`，每条样本采用 `question / expected_output / metadata` 结构。对应源码为：

- `frontend-v1/src/types/index.ts`
- `frontend-v1/src/routes/datasets.index.tsx`
- `frontend-v1/src/routes/datasets.$id.tsx`
- `frontend-v1/src/routes/datasets.new.tsx`

但它的新建流程是“选择一个 CSV/JSONL 文件 → 字段映射 → 预览 → 校验 → 固化版本”。`ParsedFile` 也是单个 `fileName` 加一组 `rows`。它并没有“原始资料集合包含多个文件”的模型。

### 3.2 可以借鉴

- 资料集合首页复用其紧凑列表外壳：名称、文件数、记录数、更新时间和进入操作。
- 资料集合详情复用其 PageHeader、卡片、表格、空状态和详情页节奏。
- 将版本外壳留给真正需要不可变版本的对象；资料集合只是文件归类，不应为了复用界面强迫它产生复杂版本状态机。
- 字体、色彩、间距、按钮、表格和弹窗继续直接遵循 `frontend-v1` 的视觉语言。

### 3.3 不能照搬

- 不能把旧 `Dataset` 直接改名为“资料集合”。它的内容是统一 `samples`，不是多个独立原始文件。
- 不能沿用“创建容器时必须同时从一个文件固化 v1”的限制。可以创建空资料集合，也可以不建集合直接上传到“未整理”。
- 不引入旧页面的 Dataset kind、负责人、Langfuse、发布状态和评测结果类型。
- 不把资料集合和测试集合并成同一种用户可见对象；前者组织源文件，后者保存经过选择和编辑的统一记录版本。

## 4. CKAN：最适合做最小关系骨架

### 4.1 已验证模式

CKAN 官方 [Datasets and resources](https://docs.ckan.org/en/2.12/user-guide.html#datasets-and-resources) 将 dataset 定义为元数据加若干 resources；resource 可以是上传文件或外部链接，一个 dataset 可以包含任意数量的 resources。官方 [Adding a new dataset](https://docs.ckan.org/en/2.12/user-guide.html#adding-a-new-dataset) 则把流程分成“先创建 dataset，再 Add Data”，并可用 `Save & add another` 连续添加资源。

结构化资源进入 DataStore 后可得到自动数据预览、搜索和筛选；官方同时明确 DataStore 与保存完整文件的 FileStore 是不同层次，见 [DataStore extension](https://docs.ckan.org/en/2.12/maintaining/datastore.html)。资源视图本身支持表格、图片等不同预览类型，见 [Data preview and visualization](https://docs.ckan.org/en/2.12/maintaining/data-viewer.html#overview)。

### 4.2 借到原型

- 采用最小关系：一个资料集合拥有零到多个文件，每个文件保留自己的名称、格式、大小、上传时间和解析状态。
- “创建集合”和“上传文件”是两个独立入口：创建时只要求名称，可选一句说明；从集合详情上传会自动归入该集合，从首页直接上传则可选择集合或保留在“未整理”。
- 同一资料集合可继续增加文件，不必每次另建一个集合。
- 用户仍可单独打开某个文件，查看其原始内容、字段映射和统一记录。
- 测试集选数时先选资料集合，再展开到文件和记录；不把文件归类层级丢掉。

### 4.3 不借

- 不出现 Organization、Publisher、Maintainer、License、Public/Private 或数据门户发布流程。
- 不允许 URL/API 资源替代本期已确认的文件上传合同。
- 不引入 DataStore、数据库或 Resource 等用户术语；界面只使用“资料集合”和“文件”。
- 不复制插件化视图配置，CSV、JSON、JSONL 仍统一映射成同一种记录表格。

## 5. Dataverse：最适合多文件上传和集合内部浏览

### 5.1 已验证模式

Dataverse 的 Dataset 明确包含多份 research files。官方 [Dataset + File Management](https://guides.dataverse.org/en/latest/user/dataset-management.html#adding-a-new-dataset) 支持多文件选择和拖放上传；文件可在保存前补充描述等信息。

官方 [File Path](https://guides.dataverse.org/en/latest/user/dataset-management.html#file-path) 说明：当数据集内文件带路径时，详情页可在普通表格和树形文件视图间切换；下载整份数据集或选中文件时保留该结构。官方 [File Previews](https://guides.dataverse.org/en/latest/user/dataset-management.html#file-previews) 则把预览放在单独的文件页面。Tabular ingest 会从文件中提取可读表格内容，并把数据和描述它的元数据分开；失败不会让原文件消失，见 [Tabular Data, Representation, Storage and Ingest](https://guides.dataverse.org/en/latest/user/tabulardataingest/ingestprocess.html)。

### 5.2 借到原型

- 资料集合详情把文件列表作为页面主体，并在右下角保留“上传文件”按钮。
- 上传弹窗允许一次选择多个文件；每个文件分别显示解析、映射和确认状态。
- 用户可单独进入文件详情，保留当前已确认的“统一记录 / 原始内容”查看方式。
- 列表显示合计文件数、合计记录数和最近更新时间，帮助用户判断集合规模。
- 解析失败只标记对应文件，不让整个资料集合不可用，也不丢弃原文件。

### 5.3 第一版不借

- 不实现任意嵌套文件夹、ZIP 自动解包、文件标签体系或目录下载；先用集合名称完成领域归类。
- 不要求 Citation metadata、作者、联系人、许可证、访问条款和发布审查。
- 不引入受限文件、Guestbook、Embargo、DOI、校验和展示或复杂文件版本规则。
- 不为每种格式安装预览插件；仅支持当前确认的 CSV、JSON、JSONL 统一记录预览。

## 6. Quilt：最适合资料集合内的文件资源管理器

### 6.1 已验证模式

Quilt 官方 [Mental Model](https://docs.quilt.bio/mentalmodel) 把 package 描述为具名、不可变、可版本化的相关文件集合。官方 [Bucket Browsing](https://docs.quilt.bio/quilt-platform-catalog-user/filebrowser) 提供文件列表、拖放上传、多选和从文件创建 package；[Document Previews](https://docs.quilt.bio/quilt-platform-catalog-user/preview) 为 CSV、JSON、文本等文件提供类型预览，并尽量读取生成预览所需的最小数据。

### 6.2 借到原型

- 资料集合详情采用“文件列表 + 右侧文件信息面板 + 明确进入箭头”的资源管理器布局。
- 单击文件行只选中并刷新右侧信息；点击箭头或双击才进入文件内容页。
- 右侧面板展示文件摘要、映射状态、记录数和少量预览；技术证据继续折叠。
- 多选只服务于批量移出/下载等实际任务；没有明确任务前不增加全局收藏夹。

### 6.3 不借

- 不显示 Bucket、S3 key、IAM、Registry、Manifest 和对象存储路径。
- 不把资料集合设计成对用户暴露哈希和包版本的 package manager。
- 不复制组织级搜索、分享和企业目录能力。

## 7. FiftyOne：只借容器内记录浏览

### 7.1 已验证模式

FiftyOne 官方 [Samples](https://docs.voxel51.com/user_guide/basics.html#samples) 将 sample 定义为 Dataset 的原子元素；sample 保存源媒体路径，并可附加字段。官方 [Importing data](https://docs.voxel51.com/user_guide/import_datasets.html) 支持从目录或已知数据格式导入样本；[FiftyOne App](https://docs.voxel51.com/user_guide/app.html) 提供样本网格、筛选侧栏、排序和展开单条样本详情。

### 7.2 可借鉴

- 进入资料集合后，同时显示“文件数”和“统一记录数”，让用户理解一个容器可以聚合多个文件的记录。
- 在跨文件记录视图中保留来源文件列，支持按文件缩小范围。
- 选中记录后使用详情弹窗展示长文本和 Metadata，不让列表无限增高。

### 7.3 不借

- 不采用 image/video/3D、label overlay、embedding、model evaluation 等视觉机器学习概念。
- 不把每个源文件误建模为一个 sample；EvalBase 的 sample 对应映射后的记录，而文件是记录来源。
- 不引入 Python/CLI 导入作为普通用户主流程。

## 8. Label Studio：只借项目内任务的统一视图

### 8.1 已验证模式

Label Studio 官方 [Import data](https://labelstud.io/guide/tasks) 说明数据先进入 Project，并被解释成一组 tasks；支持 CSV、TSV、JSON 等格式和多个任务。官方文档也明确：通过 UI 上传适合概念验证，但产品不是大规模媒体托管服务，较大场景建议外部 source storage。

### 8.2 可借鉴

- 一个稳定容器可以多次导入记录，并在容器详情统一浏览，而不是让用户回到全局文件列表寻找来源。
- 跨文件记录视图采用同一字段结构；文件格式差异只在上传映射时处理。
- 资料集合详情可提供“文件”与“全部记录”两个局部标签，但不能把它们升级成新的一级导航。

### 8.3 不借

- 不复制标注模板、Labeling Config、任务分配、审核、成员和预测导入。
- 不引入 S3/GCS/Azure/Redis 等 Source Storage 配置。
- 不把资料集合等同于标注 Project；EvalBase 只是保存、映射和浏览非敏感源数据。

## 9. 明确排除 DataHub / OpenMetadata

[DataHub](https://github.com/datahub-project/datahub) 和 [OpenMetadata](https://github.com/open-metadata/OpenMetadata) 的核心是发现、治理和描述外部数据资产，而不是为单人用户上传并直接管理几份 CSV/JSON/JSONL 原文件。它们会自然带入 owner、domain、glossary、lineage、quality、policy、service、database/schema/table 等概念。

当前需求只是按领域或方向把文件归在一起。因此不应借鉴它们的领域层级、资产目录、治理表单、血缘图、质量面板或连接器。资料集合的“名称 + 可选说明”已经足以完成第一版归类。

## 10. 推荐的原型调整

### 10.1 原始资料首页

首页显示资料集合，并保留一个系统提供的“未整理”入口；用户仍可直接搜索全部文件：

| 字段       | 示例                   | 是否必需 |
| ---------- | ---------------------- | -------- |
| 名称       | 金融问答公开资料       | 是       |
| 文件数     | 3                      | 系统计算 |
| 统一记录数 | 12,480                 | 系统计算 |
| 最近更新   | 2026-08-31             | 系统计算 |
| 简短说明   | 银行、证券相关公开问答 | 否       |

页面提供“上传文件”和“新建资料集合”两个动作。新建集合弹窗只要求名称，可选一句说明；不要重新加入责任人、使用目的、许可状态和敏感级别。直接上传不能因为用户尚未创建集合而被阻断。

### 10.2 资料集合详情

- 顶部：集合名称、说明、文件数、统一记录数。
- 主体：文件资源管理器列表。
- 右侧：当前选中文件的信息面板，继续保留。
- 右下角：“上传文件”，允许单个或多个文件。
- 局部切换：“文件”和“全部记录”；默认进入“文件”。
- 单文件进入后：继续使用现有统一记录预览、原始内容、搜索和分页。
- 全部记录视图：在统一字段前增加只读“来源文件”列。

### 10.3 上传流程

维持已确认的 `选择文件 → 解析与字段映射 → 真实数据预览 → 确认上传`。从集合详情发起时目标默认是当前集合；从首页发起时可选择一个集合，默认保留在“未整理”。

多个文件不应强行共用同一份字段映射。第一版最清楚的方式是按文件依次确认；只有表头完全一致时，才可提供一个可选的“将此映射用于其余同结构文件”，不能默认猜测。

### 10.4 测试集选数

建议使用三级但渐进展开的选择：

```text
资料集合
  → 文件
    → 统一记录
```

默认先显示资料集合，并标注文件数和记录数；展开后选择整个集合、整个文件或具体记录。已选摘要始终只显示“集合 N 个 / 文件 M 个 / 记录 K 条”，不显示内部存储对象。

## 11. 最小领域边界

建议原型只尝试引入一个新概念：

- **资料集合**：按主题、领域或方向组织数据资产的可选稳定容器。

现有“数据资产”仍是一份不可变内容及独立来源身份，不因加入或移出集合而改变。统一记录仍由每个数据资产映射产生；测试集记录继续指向精确的数据资产与原始记录，不能只指向集合。这样新增归类层不会破坏已有记录级溯源。

第一版明确不做：

- 资料集合嵌套；
- 文件夹树和任意移动层级；
- 同一文件属于多个资料集合；
- 跨资料集合共享字段映射模板；
- 资料集合级权限、负责人、许可、敏感等级和发布状态；
- 自动领域分类、数据目录、数据血缘图或治理工作流。

## 12. 最终建议

这个方向比当前“所有文件平铺”更适合管理不同领域的数据，但前提是只增加一层可选归类容器，并保留无需预建集合的直接上传。建议下一轮原型以 **CKAN 的简单关系**为主、以 **Dataverse + Quilt 的文件浏览交互**为辅，再用 **frontend-v1 的视觉和详情外壳**落地。

不建议完整照搬 Dataverse，也不建议引入 DataHub/OpenMetadata。理想结果不是一个研究数据仓库或数据治理平台，而是：用户先进入一个清楚命名的资料盒子，再像使用文件资源管理器一样上传、选择和浏览其中的文件。
