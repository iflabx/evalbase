# 测试集数据血缘与记录溯源开源项目调研

> 调研日期：2026-09-02
> 范围：只研究数据溯源与数据血缘，不评价或选用数据版本存储系统。
> 结论用途：为 EvalBase 原型和后续正式产品提供模型与交互参考，不构成依赖选型。

## 1. 先给结论

没有一个被检查的热门开源项目能直接覆盖 EvalBase 的完整需求：

```text
原始文件
  -> 映射后的原始记录
  -> 测试集某个不可变版本
  -> 每条记录的复制、修改、新增和删除事实
```

OpenLineage/Marquez、DataHub、OpenMetadata 和 Apache Atlas 都擅长展示数据资产、处理过程及其上下游；前三者还明确支持字段级血缘。但它们通常把最细粒度停在字段/列，而不是稳定记录。Pachyderm 的 `datum` 是一次流水线处理的工作单元，也不是 EvalBase 中可跨版本追踪的业务记录。

因此最适合 EvalBase 的做法是：

- **内部记录模型自己保留**：由 PostgreSQL 保存原始记录、版本记录、父记录、操作类型和字段变化；这是权威溯源。
- **数据集级血缘借鉴 OpenLineage**：用“输入数据集 + 处理活动/运行 + 输出数据集”的简单语义组织摘要。
- **网页交互优先借鉴 DataHub 和 OpenMetadata**：借用聚焦节点、上下游展开、路径高亮、边详情和字段级切换，但继续使用 EvalBase 自己的视觉合同。
- **当前不接入任何完整血缘平台**：单人产品为这部分能力额外运行 Kafka、搜索引擎、HBase 或第二套元数据服务，收益不足以抵消复杂度。

## 2. 粒度定义

| 粒度 | 能回答的问题 | EvalBase 是否需要 |
| --- | --- | --- |
| 数据集级血缘 | 哪份原始资料、哪个处理过程产生了哪个测试集版本 | 需要，适合用关系图展示 |
| 字段级血缘 | 输出的“问题/期望输出/Metadata”来自哪些输入字段、经过什么映射 | 需要，但默认隐藏在字段映射或详情中 |
| 记录级溯源 | 版本中的某条记录来自哪条原始记录，在哪个版本被增加、修改或删除，哪些字段改变 | 必须需要；也是本次候选普遍缺失的部分 |

“字段级血缘”不能替代“记录级溯源”。知道 `question <- prompt`，并不能说明测试集版本 `v3` 的第 18 条记录来自哪个文件的哪条记录，也不能说明它在 `v2` 到 `v3` 之间改了什么。

## 3. 对比结论

GitHub Star 是 2026-09-02 的动态快照，只用于衡量社区可见度，之后会变化。许可证均通过各仓库的 `LICENSE` 核对。

| 项目 | 热度/活跃度快照 | 数据集级 | 字段级 | 原生记录级 | 图/UI/API | 部署复杂度 | 对 EvalBase 的价值 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [OpenLineage](https://github.com/OpenLineage/OpenLineage) + [Marquez](https://github.com/MarquezProject/marquez) | 约 2.6k + 2.3k Star；OpenLineage 默认分支 2026-09-01 有提交 | 是：Dataset/Job/Run/Input/Output | 是：ColumnLineage facet | 否 | Marquez 有血缘图、运行详情和 HTTP API | 中：API、Web、PostgreSQL；生产通常再涉及事件生产方 | **模型首选参考** |
| [DataHub](https://github.com/datahub-project/datahub) | 约 12.6k Star；2026-09-02 活跃 | 是：实体图和 DataProcessInstance | 是：FineGrainedLineage/schemaField | 否 | 完整 Lineage Explorer、GraphQL/OpenAPI/SDK | 高：官方 quickstart 约 14 个容器，建议 8 GB RAM/13 GB 磁盘 | **交互首选参考** |
| [OpenMetadata](https://github.com/open-metadata/OpenMetadata) | 约 15.1k Star；2026-09-02 活跃 | 是：Entity Edge/Pipeline | 是：columnsLineage | 否 | 完整血缘画布、边详情、REST/SDK | 高：Server、数据库、搜索引擎、迁移和 ingestion | **边详情与字段展开参考** |
| [Apache Atlas](https://github.com/apache/atlas) | 约 2.1k Star；2026-08-26 活跃 | 是：DataSet/Process inputs/outputs | 可表达：列实体与专用 column-lineage Process | 否 | Dashboard 和 Lineage REST API | 很高：官方 Docker 路径涉及 Atlas、HDFS、HBase、Kafka，建议至少 6 GB | **抽象模型参考，不适合接入** |
| [Pachyderm](https://github.com/pachyderm/pachyderm)（对照） | 约 6.3k Star；默认分支最新提交为 2025-01-09 | 是：repo/commit/pipeline provenance | 不是主要模型 | 否；datum 不等于稳定业务记录 | Console 可看 commits、jobs、datums | 很高：以 Kubernetes、对象存储和并行流水线为核心 | 只借鉴“输入快照产生输出快照”的事实链 |

上述项目均为 Apache-2.0。即使许可证允许使用，也不意味着适合复制其页面或把其领域模型直接作为 EvalBase 产品合同。

## 4. 四个主项目

### 4.1 OpenLineage + Marquez

OpenLineage 的核心对象是 `Dataset`、`Job` 和 `Run`。运行事件把输入 Dataset、输出 Dataset 与一次 Job Run 连接起来；Dataset 还可携带版本 facet。字段级 facet 能描述输出字段依赖哪些输入字段，以及 `IDENTITY`、`TRANSFORMATION`、`AGGREGATION`、`FILTER` 等变换性质。

Marquez 是接收、聚合和显示这类元数据的服务，提供血缘图、数据集/作业搜索、运行历史和 HTTP API。它并不保存业务数据，也不替 EvalBase 决定版本标签或记录身份。

适合借鉴：

- `输入资料/版本 -> 一次映射或编辑活动 -> 输出测试集版本` 的三段语义；
- 活动包含开始、完成、失败及发生时间，但普通页面只展示成功事实或必要错误；
- 字段映射采用直接复制、转换、聚合等有限类型；
- 血缘图点击节点后展示运行和边详情。

不应照搬：

- 不把每次网页编辑包装成面向用户的“Job/Run”术语；
- 不把 OpenLineage event 当作记录级溯源数据库；
- 当前不部署 Marquez，也不要求用户理解流水线编排。

一手来源：[OpenLineage 对象模型](https://github.com/OpenLineage/OpenLineage/blob/47b78f69cb11e280947e67b3a37c2bd80203bcb3/website/docs/spec/object-model.md)、[版本 facet](https://github.com/OpenLineage/OpenLineage/blob/47b78f69cb11e280947e67b3a37c2bd80203bcb3/website/docs/spec/facets/dataset-facets/version_facet.md)、[字段级血缘 facet](https://github.com/OpenLineage/OpenLineage/blob/47b78f69cb11e280947e67b3a37c2bd80203bcb3/website/docs/spec/facets/dataset-facets/column_lineage_facet.md)、[Marquez README 与 Web/API](https://github.com/MarquezProject/marquez/blob/180f37b22387146187af1ef0279e3ee1d1ccd789/README.md)、[Marquez 部署组成](https://github.com/MarquezProject/marquez/blob/180f37b22387146187af1ef0279e3ee1d1ccd789/docs/docs/deployment/deployment.mdx)。

### 4.2 DataHub

DataHub 用实体 URN 和关系构建元数据图。`UpstreamLineage` 保存上游数据集；`FineGrainedLineage` 可以把上游字段/数据集连接到下游字段，并附带变换、可信度和查询。`DataProcessInstanceInput/Output` 又能表示一次处理实例消费和产生的资产。

它的 Lineage Explorer 已实现节点展开、字段级切换、搜索过滤、路径阅读、影响分析和缩放等成熟交互。这些交互比整套后端更值得 EvalBase 借鉴。

适合借鉴：

- 以当前查看对象为中心，上游在左、下游在右；
- 默认只展开一层，用户按需继续展开，避免图一开始铺满页面；
- “数据集关系”和“字段关系”分层切换，不在同一画面混杂所有细节；
- 点击节点或边后在侧栏显示来源、变换、时间和记录数量摘要；
- 搜索定位、当前路径强调和无关分支弱化。

不应照搬：

- 不引入完整的企业数据目录、所有权、治理、认证、数据产品和影响审批；
- 不采用 DataHub URN/Aspect 体系作为 EvalBase 的业务表结构；
- 不运行其 quickstart。官方文档列出的 14 个容器和建议资源明显超过当前单人产品所需。

一手来源：[UpstreamLineage 模型](https://github.com/datahub-project/datahub/blob/05eac7c56e3ab3c111163dbac6a8998aab2127a2/metadata-models/src/main/pegasus/com/linkedin/dataset/UpstreamLineage.pdl)、[FineGrainedLineage 模型](https://github.com/datahub-project/datahub/blob/05eac7c56e3ab3c111163dbac6a8998aab2127a2/metadata-models/src/main/pegasus/com/linkedin/dataset/FineGrainedLineage.pdl)、[处理实例输入](https://github.com/datahub-project/datahub/blob/05eac7c56e3ab3c111163dbac6a8998aab2127a2/metadata-models/src/main/pegasus/com/linkedin/dataprocess/DataProcessInstanceInput.pdl)、[Lineage Explorer 前端目录](https://github.com/datahub-project/datahub/tree/05eac7c56e3ab3c111163dbac6a8998aab2127a2/datahub-web-react/src/app/lineageV3)、[Quickstart 资源与服务](https://github.com/datahub-project/datahub/blob/05eac7c56e3ab3c111163dbac6a8998aab2127a2/docs/quickstart.md)。

### 4.3 OpenMetadata

OpenMetadata 的血缘边连接 `fromEntity` 与 `toEntity`，边详情可以包含 SQL、Pipeline、描述、来源类型、创建/更新时间以及字段映射。它提供新增血缘的 REST 请求模型，也有完整的交互式血缘画布。

适合借鉴：

- 图保持简洁，详细信息放在选中边的侧栏；
- 边上显示“直接来源、映射处理、版本派生”等少量可读类型；
- 字段级关系按需展开，并能从一个输出字段反查输入字段；
- 节点较多时使用搜索、按需加载和上下游方向筛选。

不应照搬：

- 它的字段血缘仍不是逐条记录历史，不能把 `columnsLineage` 改名后当作记录 provenance；
- 不引入其团队、Owner、治理、质量、Glossary、Connector 等日常 UI；
- 不为单一应用再部署 Server、搜索引擎、迁移与 ingestion 服务。

一手来源：[EntityLineage 与字段边 Schema](https://github.com/open-metadata/OpenMetadata/blob/ac760c8143f4380ded357c514ab38798b06fd47e/openmetadata-spec/src/main/resources/json/schema/type/entityLineage.json)、[AddLineage API Schema](https://github.com/open-metadata/OpenMetadata/blob/ac760c8143f4380ded357c514ab38798b06fd47e/openmetadata-spec/src/main/resources/json/schema/api/lineage/addLineage.json)、[血缘 UI 源目录](https://github.com/open-metadata/OpenMetadata/tree/ac760c8143f4380ded357c514ab38798b06fd47e/openmetadata-ui/src/main/resources/ui/src/components/Entity/EntityLineage)、[官方 Quickstart Compose](https://github.com/open-metadata/OpenMetadata/blob/ac760c8143f4380ded357c514ab38798b06fd47e/docker/docker-compose-quickstart/docker-compose-postgres.yml)。

### 4.4 Apache Atlas

Atlas 的基础模型以 `DataSet` 和 `Process` 表达数据及处理关系，Process 有 `inputs` 和 `outputs`；特定系统可以扩展类型，例如 Hive 模型把列建成实体，并用 `hive_column_lineage` Process 表达字段依赖。它提供血缘查询 API 和 Dashboard。

适合借鉴：

- 将“资料/测试集版本”和“映射/编辑活动”建成不同种类的节点；
- 关系边只保存稳定标识，展示所需摘要从节点和活动事实生成；
- 领域模型允许扩展，但共用最小的 input/process/output 骨架。

不应照搬：

- 不引入 Atlas 的分类传播、Ranger 权限和 Hadoop 生态模型；
- 不让用户创建任意实体类型或手工绘制任意血缘边；
- 不接入其 Atlas/HDFS/HBase/Kafka 部署栈。

一手来源：[Atlas 基础 DataSet/Process 模型](https://github.com/apache/atlas/blob/df4d8248780a2d1d516400603166805fa645d7fb/addons/models/0000-Area0/0010-base_model.json)、[Hive 字段血缘模型](https://github.com/apache/atlas/blob/df4d8248780a2d1d516400603166805fa645d7fb/addons/models/1000-Hadoop/1030-hive_model.json)、[Lineage API 示例](https://github.com/apache/atlas/blob/df4d8248780a2d1d516400603166805fa645d7fb/atlas-examples/sample-app/src/main/python/lineage_example.py)、[官方 Docker 依赖说明](https://github.com/apache/atlas/blob/df4d8248780a2d1d516400603166805fa645d7fb/dev-support/atlas-docker/README.md)。

## 5. Pachyderm 对照：`datum` 不是记录级溯源

Pachyderm 把数据 repo 的不可变 commit、pipeline、job 和输出 commit 串成 provenance，并可将输入拆成 datums 并行处理。它很适合回答“哪个输入快照和哪次流水线运行产生了这个输出快照”。

但 datum 的身份由 pipeline input spec 和本次 job 切分方式决定，可以是一份文件、一组文件或组合输入；它不是 EvalBase 中具有稳定 ID、可跨版本修改并保留删除事实的测试记录。因此，即使借鉴其图，也仍需 EvalBase 自己保存记录来源和变化。

可借鉴的仅是：每个发布版本都指向明确输入快照和一次成功活动；失败活动不产生领域可见的已发布输出。不要引入 Kubernetes、自动并行流水线或 Pachyderm 服务。

一手来源：[Pachyderm 官方 README](https://github.com/pachyderm/pachyderm/blob/e237475e9910a2d6299d7d2c3d6fc3b9a8f28f0b/README.md)、[Console Datum Viewer 源目录](https://github.com/pachyderm/pachyderm/tree/e237475e9910a2d6299d7d2c3d6fc3b9a8f28f0b/console/frontend/src/views/DatumViewer)、[Apache-2.0 License](https://github.com/pachyderm/pachyderm/blob/e237475e9910a2d6299d7d2c3d6fc3b9a8f28f0b/LICENSE)。

## 6. EvalBase 建议采用的最小模型

这些是可借鉴的概念，不是要求立即修改正式合同：

```text
资料文件/资料记录 --输入--> 变换活动 --输出--> 测试集版本/版本记录
测试集版本       --父版本--> 测试集版本
版本记录         --父记录--> 上一版本记录
```

权威事实建议分两层：

1. **关系图摘要**：节点只放资料、测试集版本和活动；边表达输入、输出、父版本，适合人快速理解。
2. **记录溯源明细**：表格按稳定记录 ID 展示 `copied`、`modified`、`added`、`deleted`，并列出原始资料定位、父记录和改变字段；这是下载 `provenance.csv` 的来源。

原型/UI 最值得增加或保持的交互是：

- 默认显示当前测试集版本及一层直接来源，不一次展开全部历史；
- 点击“查看来源”进入独立视图，上方是简洁关系图，下方是可搜索的记录溯源表；
- 图中选择资料、版本或边后，右侧详情显示映射、时间、记录数及增删改数量；
- 可在“版本关系 / 资料来源 / 字段映射”之间切换，记录级内容继续放表格，不画成上万节点的图；
- 高亮当前节点的完整上游路径，无关分支降低对比度；
- 下载的数据/溯源包继续以 EvalBase 自己的 CSV 合同为准。

明确不采用：手工画边、图上拖动改父版本、自动合并、治理审批、多用户 Owner/角色、企业数据目录、血缘平台登录页、Kafka/搜索引擎/HBase 等新服务。

## 7. 最终推荐顺序

1. **OpenLineage/Marquez**：学习最小的 Dataset/Activity/Run/Input/Output 语义。
2. **DataHub**：学习成熟的上下游浏览、路径高亮、按需展开和字段级切换。
3. **OpenMetadata**：学习边详情、字段映射详情和图/表分层。
4. **Apache Atlas**：仅作为可扩展类型模型的旁证，不作为产品或部署方案。

综合结论不是“选择其中一个接入”，而是“用 EvalBase 的轻量领域模型保存记录级事实，再选择性借鉴前三者已经验证过的血缘表达和浏览交互”。

## 8. 本轮原型采用与源码边界

`v5` 原型只在本仓库的 Throwaway HTML 中增加轻量关系图、选中详情、记录级溯源表和 `provenance.csv` 字段；没有安装或复制 OpenLineage、Marquez、DataHub、OpenMetadata、Apache Atlas、Pachyderm 或 VGraph 的源码、包或示例页面。

本轮实际借鉴关系如下：OpenLineage/Marquez 用于资料、父版本和测试集版本之间的最小事实语义；DataHub 用于聚焦当前版本；OpenMetadata 用于按需显示字段映射。页面不再绘制来源关系图，而以文字摘要解释当前版本从哪里来、改了什么。记录级的稳定测试用例、用例修订、增改删事实与 CSV 表头均为 EvalBase 自己的原型实现，不能归因于这些项目。

外部源码的精确固定版本、源码路径、许可证、当前使用状态与未来复用条件记录在 [`test-dataset-lineage-source-reuse-register.md`](test-dataset-lineage-source-reuse-register.md)。该登记表是后续正式 Ticket 复制或小幅改写上游代码前的必经记录，不因本调研而自动授权复制。
