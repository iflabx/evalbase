# 测试数据管理参考产品与一手资料调研

| 项目 | 内容 |
| --- | --- |
| 调研日期 | 2026-08-17 |
| 调研目的 | 为 EvalBase 第一阶段“原始数据 → 正式测试集”提供产品与领域模型依据 |
| 资料范围 | 仅使用项目官方文档、官方 GitHub 仓库/源码和官方 API 文档 |
| 重点能力 | 原始来源导入、Dataset/Record、探索与策展、变换流水线、版本、血缘、审计、人审、Langfuse 交付 |
| 时效说明 | 产品能力会变化；尤其 Langfuse 本文按 2026-08-17 的现行文档核对 |

## 1. 执行结论

没有一个参考项目同时解决 EvalBase 所需的“原件保全、raw-first 策展、不可变发布版本、用例级血缘、人审门禁和 Langfuse 交付”。正确做法不是选一个项目照搬，而是组合四类成熟模式：

1. 借 **Easy Dataset** 的阶段化用户旅程，但不借它以内容生成和评测为中心的一体化边界。
2. 借 **Argilla** 的 `Record / Suggestion / Response` 分层和人工审核工作台，但反转它“先建 Schema、后导入”的入口。
3. 借 **Lilac** 的 raw-first Explore、筛选切片、派生信号列和软排除交互，但只把它当历史交互参考，不能作为活跃依赖。
4. 借 **OpenDCAI/DataFlow** 的 `Pipeline → Operator → Prompt` 契约和运行记录思想，但让清洗、改写、扩写继续作为外部工具，不在 MVP 中建设通用执行引擎。

综合 DVC、OpenLineage、Hugging Face Datasets 与 Langfuse 的一手资料后，EvalBase 应采用下列主链：

```text
不可变数据资产
  → 可重建的统一解析视图 / 可定位原始记录
  → 工作草稿 + 策展方案
  → 不可变候选快照
  → 不可变测试集版本
  → 交付记录（文件或 Langfuse）
```

同时维护两条不同但相关的记录：

- **血缘**：哪个输入，经哪个策展方案或处理运行，产生了哪个输出。
- **审计**：谁在何时对哪个对象执行了什么操作，结果是什么。

两者不能用一个“操作日志”字段代替。血缘描述数据因果关系，审计描述责任与行为历史。

上传格式的统一边界应是：原始 CSV/JSON/JSONL 不转换、不扁平化、不改值；格式适配器统一暴露 Source Record 的寻址、字段访问、类型提示与错误模型；只有发布的正式测试用例才强校验为统一契约。Arrow/Parquet 如用于性能，只能是由原始资产与解析配置重建的缓存。

基于 Langfuse 当前入口能力，正式版本和交付方式应解耦：EvalBase 以 `items.jsonl + manifest.json + lineage.jsonl` 作为本地标准版本包；Phase 1A 按需生成 `langfuse.csv` 供 UI 人工导入；Phase 1B 通过 SDK/API 直接发送结构化 JSON。CSV 是可重建的交付适配物，不是版本真源或幂等同步协议。

## 2. 项目身份与资料可靠性

### 2.1 Easy Dataset

本文所指 Easy Dataset 是 [ConardLi/easy-dataset 官方仓库](https://github.com/ConardLi/easy-dataset)。其官方说明把产品定义为面向 LLM 微调、RAG 和评测的数据构建工具，核心旅程是文献处理、问题生成、答案构建、标签管理与导出。[官方产品介绍](https://docs.easy-dataset.com/ed/en)也明确采用 project-based 工作方式。

### 2.2 DataFlow

“Transformation Pipeline / Operator”的表述与 [OpenDCAI/DataFlow 官方仓库](https://github.com/OpenDCAI/DataFlow)完全对应：官方将其描述为通过 operator-based 设计，把生成、清洗、评估、过滤组织为可复用 pipeline。因此本文确认用户所指 DataFlow 为 **OpenDCAI/DataFlow**，而不是其他同名数据工具。

### 2.3 Lilac

原 Lilac AI 项目的可信官方源码现为 [databricks/lilac](https://github.com/databricks/lilac)，仓库所有者已于 **2025-07-25** 将其归档并设为只读。历史官方文档仍可从 [docs.lilacml.com](https://docs.lilacml.com/)读取，但不代表项目仍在活跃维护。当前 `github.com/lilacai/lilac` 已不是本调研所指的数据策展产品，不作为来源或依赖候选。

结论：Lilac 可以用于研究 2024 年前后的产品交互与数据策展思想，不能作为 EvalBase 的核心技术依赖，也不应以其历史文档推断当前维护承诺。

## 3. 横向比较

| 项目 | 原始来源导入 | Dataset / Record 模型 | 探索与策展 | 变换流水线 | 版本、血缘、审计 | 人审 | 对 EvalBase 的主要价值 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Easy Dataset | 主要从 PDF、Markdown、DOCX、TXT、EPUB 等文献进入生成链；当前版本也支持既有测试集导入 | 文件、文本块、问题、答案/数据项相互关联 | 筛选、编辑、AI 优化、标签、备注、评分、确认、导出 | 内置生成、清洗、优化和评测任务 | 能回看关联文本块；官方模型未呈现一等 `DatasetVersion`、父版本或不可变运行快照 | 有单条确认，但确认不阻断导出 | 阶段化旅程与详情页回看来源 |
| Argilla | 先定义 Dataset Settings，再按字段映射导入 Records | `Settings + Record(fields, metadata, vectors, suggestions, responses)` | 全文、元数据、建议、回答、状态和向量筛选 | 不是通用变换引擎 | 记录可按 ID 原地更新；Webhook 是通知；官方文档未提供不可变版本 DAG | 最强：Pending/Draft/Submitted/Discarded、多人提交、指南 | 机器建议与人工判断分离、审核队列与门禁 |
| Lilac | HF、Parquet、CSV、JSON、SQLite、Pandas 等，导入后直接 Explore | Dataset + 配置化 source/signals/embeddings；信号成为派生列 | 搜索、聚类、概念、分组、标签、切片、软删除、导出 | Python `map`、Signal 与计算任务 | 项目配置有一定可复现性，但不是正式发布版本、运行血缘或审计体系 | 有标注/概念示例，不是完整多人审核流 | raw-first Explore、派生信号、切片操作、软排除 |
| OpenDCAI/DataFlow | JSON、JSONL、CSV、Parquet、Pickle 等进入 FileStorage | 表格型 DataFrame；Operator 读写显式字段 | 依靠 operator 过滤、评分、生成、改写 | 最强：`Pipeline → Operator → Prompt`，可预编译检查和分步缓存 | Python/Git 与 step cache 有助复用/恢复，但 cache 不是语义版本、血缘或审计 | 非核心能力 | 外部处理清单、运行快照、输入输出契约 |

以上“未提供”均表示在本次核对的官方文档和公开模型中未发现满足 EvalBase 语义的一等对象，不等于断言项目内部绝无任何历史记录。

## 4. Easy Dataset

### 4.1 已验证能力

Easy Dataset 的主要路径是把领域文献加工成训练或评测数据。[官方仓库](https://github.com/ConardLi/easy-dataset)列出文档解析、文本切分、问题/答案生成、数据清洗、AI 质量评分、标签、后台任务和导出等能力；[官方产品介绍](https://docs.easy-dataset.com/ed/en)把整个链路组织在项目下。

其当前公开数据模型可从 [Prisma schema](https://github.com/ConardLi/easy-dataset/blob/main/prisma/schema.prisma)看到有限但实用的来源关联：

- `UploadFiles` 保存文件名、扩展名、路径、大小和 MD5。
- `Chunks` 指向文件并保存文本块内容。
- `Questions` 指向文本块。
- `Datasets` / `EvalDatasets` 保存问题、答案、模型、标签、分数、备注等，并能关联问题或文本块。

这使单条结果可以回看上游文本块。[数据集管理官方文档](https://docs.easy-dataset.com/shu-ju-ji/shu-ju-ji-guan-li)展示了筛选、手工修订、AI 优化、自定义标签/备注/评分、AI 质量评估以及从数据项跳回原始文本块的交互。文档还明确说明“确认”只是状态标记，**未确认的数据也可以导出**。

[数据集导出官方文档](https://docs.easy-dataset.com/ed/en/datasets/dataset-export)显示可导出 JSON、JSONL、Excel，支持 Alpaca、ShareGPT 和自定义字段格式；[官方 Releases](https://github.com/ConardLi/easy-dataset/releases)还记录了测试集导入、筛选、确认撤销、平衡导出和大数据量分批导出等演进。

### 4.2 值得借鉴

- 把复杂过程拆成用户能理解的阶段，并在每一阶段给出明确下一步。
- 数据项详情页同时展示结果和来源文本，降低核验成本。
- 支持筛选后批量操作、单条修订、标签/备注和导出预览。
- 长耗时生成与评估进入后台任务，显示进度并可中断。

### 4.3 不应照搬

- **不要把“项目”同时当原始来源、工作区和正式测试集。** EvalBase 需要稳定的测试集身份和多个不可变版本。
- **不要以文档生成链作为 raw-first 导入模型。** EvalBase 第一入口是 CSV、JSON、JSONL 原件保全，用户应先看到数据再定义正式结构。
- **不要让确认成为不影响发布的装饰状态。** 若 MVP 提供“已复核/可发布”，它必须进入发布校验门禁；否则应只叫标签。
- **不要把清洗、扩写、推理、Judge 和报告全部塞进第一阶段。** Easy Dataset 的一体化适合生成工具，不符合 EvalBase 当前“管理控制面”的边界。
- **不要原地覆盖正式内容。** 公开 schema 中未看到一等父版本、不可变 DatasetVersion、TransformationRun 或 PromptSnapshot，EvalBase 必须补齐。

## 5. Argilla

### 5.1 已验证能力

Argilla 将 Dataset 定义为供标注者反馈的一组 Records。创建 Dataset 时先配置 `fields`、`questions`、`metadata`、`vectors`、`guidelines` 和 `distribution`；官方示例可设置 `TaskDistribution(min_submitted=2)`，要求每条记录至少有两份提交。[Dataset 官方文档](https://docs.argilla.io/latest/how_to_guides/dataset/)

Record 的结构是本次调研中最值得借鉴的部分：[Record 官方文档](https://docs.argilla.io/latest/how_to_guides/record/)展示了 `fields`、`metadata`、`vectors`、`suggestions`、`responses` 和 `external_id`。其中：

- `Suggestion` 是模型预测等机器建议，可保存值、置信分数和 agent。
- `Response` 是带用户身份的人工作答，可与机器建议并存。
- `metadata` 与 `vectors` 可分别支持业务过滤和相似度检索。

[Annotation UI 官方文档](https://docs.argilla.io/latest/how_to_guides/annotate/)提供 Pending、Draft、Submitted、Discarded 队列、Focus/Bulk 两种视图、任务指南、快捷键和进度；[Query 官方文档](https://docs.argilla.io/latest/how_to_guides/query/)支持全文查询、组合条件、状态过滤和向量相似度。

导入方面，官方要求先创建带 Settings 的 Dataset，再写入 Records。源字段与目标字段不一致时，需要 `mapping`；记录字段还必须匹配先前配置。[Record 导入示例](https://docs.argilla.io/latest/how_to_guides/record/)和[完整导入/导出文档](https://docs.argilla.io/latest/how_to_guides/import_export/)均体现了这个 schema-first 顺序。Dataset 设置和 Records 可以导出到本地磁盘或 Hugging Face Hub。

记录更新通过携带 `id` 再次 `records.log` 完成，是原地更新语义。[Webhook 官方文档](https://docs.argilla.io/latest/how_to_guides/webhooks/)提供 dataset、record、response 等事件的实时通知，但 Webhook 本身不是不可变审计存储。

### 5.2 值得借鉴

- 将原始内容、机器建议、人工回答、审核结论分成不同对象，禁止把 AI 结果伪装成人工确认结果。
- 审核页面提供清晰指南、状态队列、批量视图和最少提交人数。
- 可按 metadata、suggestion、response、score、agent 和状态组合过滤，适合策展与质检。
- `external_id` 思想适合保留上游稳定标识，但 EvalBase 仍需自己的系统 ID 和原始位置标识。

### 5.3 不应照搬

- **不要复制“先建 Settings、后导入 Records”。** 这正是现有 EvalBase 流程的主要摩擦；应先保存原件和解析预览，再做字段映射。
- **不要把标注进度当测试集生命周期。** Pending/Submitted 描述某个人的回答状态，不等于 Draft/Candidate/Published/Archived。
- **不要把 `id` 原地更新当版本管理。** 发布版本必须不可变，修改应产生新修订或新版本。
- **不要把 Webhook 当审计日志。** Webhook 可能丢失、重试或乱序；审计事件应由 EvalBase 自己追加保存。
- Phase 1A 不需要复制完整标注团队管理和共识算法；可以先保留简单复核与发布门禁，把多人标注放到后续阶段。

## 6. Lilac（历史交互参考）

### 6.1 已验证能力

[归档的官方仓库](https://github.com/databricks/lilac)将 Lilac 定义为用于 LLM 数据探索、策展和质量控制的工具，支持从 Hugging Face、Parquet、CSV、JSON、LangSmith、SQLite、Pandas 等来源加载数据。其核心交互是导入后直接 Explore，而不是先建立正式目标 Schema。

Lilac 的探索能力包括关键词/语义/概念搜索、聚类、过滤、分组和标签；`Signal` 接收文本或 embedding 并返回 metadata，可计算语言、PII、文本统计、近重复等派生列。[Signals 官方文档](https://docs.lilacml.com/signals/signals.html)说明 Signal 可由 Python 函数、模型或外部服务实现；[官方仓库说明](https://github.com/databricks/lilac)展示了 signal 计算后新增字段、按过滤条件批量打标签和导出标签。

[Quick Start](https://docs.lilacml.com/getting_started/quickstart.html)展示了以过滤、标签和删除来策展切片；被删除的行默认不进入导出，但仍可在界面切换查看，属于有用的“软排除”交互。其 [Python API Quick Start](https://docs.lilacml.com/getting_started/quickstart_python.html)和 [`DatasetConfig` API](https://docs.lilacml.com/api_reference/index.html)把 source、signals、embeddings 等配置组织起来，为重现探索计算提供了一定基础。

### 6.2 值得借鉴

- 上传后立刻展示字段、样本和质量信号，允许用户“先理解再映射”。
- 把自动质量结果作为派生列，不覆盖原始字段。
- 允许对某条记录或某个过滤切片执行标签、排除等动作。
- 使用软排除并在导出时默认排除，保留撤销和核验能力。
- 对耗时计算提供预览、进度和可恢复执行。

### 6.3 不应照搬

- **不得把 Lilac 作为活跃依赖。** 官方仓库已归档，当前同名仓库不可信。
- **不要把 Signal、标签或 `__deleted__` 当正式版本。** 它们是工作状态或派生字段，不能替代不可变发布快照。
- **不要把缓存和项目配置误认为完整血缘。** EvalBase 仍需记录输入版本、运行参数、输出版本、操作者和时间。
- **不要在 MVP 复制 embedding、聚类、概念训练、PII 检测等广泛能力。** 这些可以由独立工具产生派生资产，EvalBase 只管理结果与血缘。
- Lilac 缺少 EvalBase 所需的正式发布门禁和多人审核语义，不能直接套用其“编辑当前 Dataset”的模型。

## 7. OpenDCAI/DataFlow

### 7.1 已验证能力

[官方仓库](https://github.com/OpenDCAI/DataFlow)明确采用 `Pipeline → Operator → Prompt` 层级。Operator 对结构化输入执行单一任务，调用时声明 `input_key` 和 `output_key`；示例把 `problem` 读取后把生成结果写入 `solution`。官方同时提供生成、评估、过滤和改写等 operator 类别。

[Framework Design](https://opendcai.github.io/DataFlow-Doc/en/guide/basicinfo/framework/)进一步拆分 Operator、Pipeline、Storage、LLMServing 和 Agent。当前内核以 Pandas DataFrame 作为数据载体，支持 JSON、JSONL、CSV、Parquet、Pickle 等文件格式；`FileStorage` 主要依赖文件系统读写和缓存。

[First Pipeline](https://opendcai.github.io/DataFlow-Doc/en/guide/first_pipeline/)和[Text Pipeline](https://opendcai.github.io/DataFlow-Doc/en/guide/textpipeline/)展示了多个 operator 依次调用 `storage.step()`；分步文件便于检查和恢复。[Framework Design 的预编译章节](https://opendcai.github.io/DataFlow-Doc/en/guide/basicinfo/framework/)还提供 `compile()` 对 operator 字段依赖做运行前检查和绘制图。官方示例也允许把输出写回 `raw_content`，这对短期流水线方便，但不符合正式数据审计要求。

### 7.2 值得借鉴

EvalBase 不需要执行 DataFlow，但应要求外部处理清单至少表达：

| 字段 | 含义 |
| --- | --- |
| operator | 操作类型和实现版本 |
| purpose | 本次处理用途 |
| input fields / output fields | 输入与输出字段契约 |
| parameters | 完整参数、过滤条件、抽样种子等 |
| prompt snapshot | 提示词原文或不可变快照及哈希 |
| model config | 提供方、模型、温度、seed 等 |
| code/tool version | 工具版本、代码提交或镜像摘要 |
| run | 输入资产/版本、输出资产、状态、开始/结束、计数和错误 |

第一版只需支持有序步骤列表；不必实现任意 DAG 编辑器。导入外部结果时，处理清单作为 `Transformation Run` 的不可变证据，输出登记为新的派生资产。

### 7.3 不应照搬

- **step cache 不是 Dataset Version。** 它主要服务恢复和调试，没有正式发布语义、父版本、审核或稳定版本号。
- **Python 代码和 Git 历史不是数据实例血缘。** 同一代码可能在不同输入、模型、Prompt 和参数上运行，必须保存本次运行快照。
- **不允许覆盖正式字段。** 即使 operator 支持把输出写回输入列，EvalBase 也应保留原件并产生派生资产/新修订。
- **不要在 Phase 1A 内置 100+ operators、模型服务或 Agent 自动编排。** 当前范围只需要管理外部处理的输入、输出和证据。
- **不要先做通用 DAG。** 线性策展方案已足够覆盖筛选、抽样、包含/排除和字段映射的 MVP。

## 8. 补充参考一：Langfuse——必须满足的下游合同

Langfuse 不是一般意义上的 raw source 管理平台，但它是 EvalBase 正式测试集的关键消费端，因此其数据模型和约束应直接进入验收标准。

### 8.1 当前数据模型

根据 [Langfuse Experiments Data Model](https://langfuse.com/docs/evaluation/experiments/data-model)：

| 对象 | 核心字段与约束 | 对 EvalBase 的含义 |
| --- | --- | --- |
| Dataset | `id`、项目内唯一 `name`、description、metadata，可选远程实验配置 | 一个长期稳定的 EvalBase Test Set 可映射到一个稳定 Langfuse Dataset |
| DatasetItem | 项目级唯一 `id`、datasetId、可选 input、expectedOutput、metadata、mediaReferences、sourceTraceId/sourceObservationId、ACTIVE/ARCHIVED | Item ID 按 `id` upsert，且不能跨 Dataset 重用；映射键必须含 EvalBase Test Set 身份与 Test Case 身份 |
| DatasetRun | id、name、description、metadata、datasetId | 属于第二阶段评测结果域 |
| DatasetRunItem | datasetRunId、datasetItemId、traceId、可选 observationId | 每次实验把固定 Item 与 Trace 关联；当前一次实验中同一 Item 至多出现一次 |

Langfuse 的 input 和 expectedOutput 在 API 层都可以为空，且接受结构化对象或值；EvalBase 可以施加更严格约束，例如正式测试用例的 `input` 必填。[Datasets 官方文档](https://langfuse.com/docs/evaluation/experiments/datasets)

### 8.2 Langfuse 已有版本功能，但边界有限

截至本调研日期，Langfuse **已经支持 Dataset 版本**，不能沿用“Langfuse 没有版本管理”的旧结论。[现行官方文档](https://langfuse.com/docs/evaluation/experiments/datasets#versioning)说明：

- 每次 Dataset Item 的 add、update、delete 或 archive 都产生新的时间戳版本。
- 可以用 `version` 时间戳读取历史 Dataset 状态，并在该版本上运行实验。
- 版本适用于 **Dataset Items**；Dataset Schema 的修改不会产生版本。

这仍不能替代 EvalBase 的正式版本：

- 时间戳不是业务可读的版本号、发布说明或父版本关系。
- 一次批量同步会形成多个中间时间点；EvalBase 只能把“全部完成后的远端时间戳”登记为成功交付版本。
- Schema 变化不进入 Langfuse 版本，EvalBase 必须保存映射和 Schema 快照。
- Langfuse 不保存 CSV/JSON/JSONL 原件、外部处理链和通用来源说明。

### 8.3 导入与校验约束

[官方 CSV 上传说明](https://langfuse.com/changelog/2025-01-27-Dataset-Items-csv-upload)明确：

- CSV 必须有表头。
- 列可拖拽映射到 input、expected output 或 metadata。
- 多列映射到同一目标会组成结构化 JSON。
- **未映射列会被忽略。**

[Datasets 官方文档](https://langfuse.com/docs/evaluation/experiments/datasets)补充：CSV 导入适合文本和结构化 JSON；多模态应使用条目编辑器或 SDK；Dataset 上传用于 input 和 expected output，若已经有模型生成的 actual output，应使用 Experiments SDK。Langfuse 还支持为 input/expectedOutput 配置 JSON Schema，非法 Item 会被拒绝；从 Observations 批量加入时支持 JSONPath/自定义对象映射、预览、部分成功和错误日志。

因此 EvalBase 的导入器不能直接复制 Langfuse CSV uploader：EvalBase 必须先保留所有原始列，并要求用户显式确认未映射列的处置，不能静默丢弃。

### 8.4 EvalBase 格式决策

- **正式版本**：`items.jsonl` 每行一条 `case_id / input / expected_output / metadata` 测试用例；`manifest.json` 和 `lineage.jsonl` 固化版本与来源证据。
- **人工导入**：Phase 1A 可生成 UTF-8 `langfuse.csv`，包含 `input / expected_output / metadata` 三列 JSON 单元格；`metadata._agentbench` 携带本地 case/version 引用。
- **自动同步**：Phase 1B 不读取 CSV，而是通过 SDK/API 发送结构化 JSON，并用 EvalBase 命名空间、Test Set ID 与 Test Case ID 确定性生成远端 item ID。
- **边界**：CSV 文件哈希、导出配置和人工确认写入 Delivery Record，但不进入正式版本业务内容哈希；人工重复上传不宣称幂等。

### 8.5 同步工程约束

- 使用稳定 Langfuse Dataset；Item ID 应由 EvalBase 实例/命名空间、Test Set ID 和 Test Case ID 确定性生成，既支持同一用例跨本地版本 upsert，又避免项目级跨 Dataset 冲突。
- 每次同步保存本地版本 ID、映射版本、目标 Dataset ID/name、逐项 ID 映射、请求计数、成功/失败、最终远端版本时间戳和同步清单哈希。
- 对本地版本已删除、但此前由 EvalBase 同步的条目执行 archive；不得删除无法确认归属的远端条目。
- 同步必须分批、幂等、可重试并尊重 `429 Retry-After`。[Langfuse Cloud 官方限制](https://langfuse.com/faq/all/api-limits)为每请求/响应 5 MB，Dataset API 按方案为每组织 100、200 或 1,000 请求/分钟；自托管实例无统一硬限制。
- 本地 Dataset 直接跑 SDK 实验时，Langfuse 只产生 Traces，不产生 DatasetRun；若需要原生运行比较视图，应先交付到 Langfuse Dataset。[Experiments Data Model](https://langfuse.com/docs/evaluation/experiments/data-model#local-datasets)

### 8.6 为什么 Langfuse 不能成为审计真源

[Data Retention 官方文档](https://langfuse.com/docs/administration/data-retention)说明 Trace、Observation、Score 和 Media 可以按保留策略独立删除；即使 Dataset 引用了 Trace，Trace 到期删除后 Dataset Run Item 也可能指向不存在的对象。因此 EvalBase 必须持久保存交付清单、外部 ID 和必要配置快照，不能只保存一个 Langfuse 链接。

若外部改写/扩写使用 Langfuse Prompt Management，[Prompt Version Control 官方文档](https://langfuse.com/docs/prompt-management/features/prompt-version-control)显示固定 version ID 与可移动 labels 是不同概念。处理血缘必须记录提示词内容/哈希和固定 version；只记录 `latest` 或 `production` label 无法重现历史运行。

## 9. 补充参考二：DVC——内容寻址与可复现配方

[DVC Get Started](https://doc.dvc.org/start)展示了一个适合借鉴的分层：原始大文件进入内容寻址 cache/remote，小型 `.dvc` 元数据保存路径和内容哈希，并由 Git 记录历史；不同 Git 修订可以恢复精确数据版本。`dvc.yaml` 用人可读的 stages、deps、params、outs 描述处理配方，[官方 `dvc.yaml` 文档](https://doc.dvc.org/user-guide/project-structure/dvcyaml-files)说明其可与代码一起版本化。

EvalBase 应借鉴：

- 原始字节以 SHA-256 等内容哈希标识，内容相同可去重，语义元数据仍各自保留。
- “人可读的策展方案”与“本次运行解析后的锁定快照”分开。
- 输出版本保存完整 manifest hash，支持重复导出一致性校验。
- 外部来源同时记录 source descriptor、取得时的 revision/etag/version 和本地不可变副本。[`dvc import-url` 官方文档](https://doc.dvc.org/command-reference/import-url)

不建议 MVP 直接引入 DVC：它依赖 Git/CLI 心智，主要是文件级版本和 pipeline，不提供 Record 策展、人审、用例级来源或产品审计。EvalBase 可在对象存储和数据库中实现同样的内容寻址/manifest 思想。

## 10. 补充参考三：OpenLineage——运行与血缘词汇

[OpenLineage Object Model](https://openlineage.io/docs/spec/object-model/)以 `Job` 表示可重复的处理定义，以 `Run` 表示一次执行，以 Input/Output Dataset 表示数据依赖；运行生命周期用 START 及 COMPLETE/FAIL/ABORT 等事件描述。[Facets 官方文档](https://openlineage.io/docs/spec/facets/)允许给 Run、Job、Dataset 附加可扩展元数据，并已有 [Dataset Version Facet](https://openlineage.io/docs/spec/facets/dataset-facets/version_facet/)、执行参数、源码位置和列级血缘等标准 facet。

EvalBase 应借鉴：

- 区分“策展/处理定义”和“某次运行”。
- 运行明确连接输入版本与输出资产/快照，并记录状态、参数、操作者和时间。
- Prompt、模型、seed、工具版本、筛选表达式可以作为不可变运行 facet。
- 失败运行也保留事件与错误，不产生可发布版本。

不必在 MVP 实现完整 OpenLineage 协议或部署 Marquez。OpenLineage 是血缘元数据标准，不是数据存储、版本库、审核平台或执行器；它也不能自动解决逐行来源。内部表与其概念同构即可，未来再做协议输出。

## 11. 补充参考四：Hugging Face Datasets / Hub——导入适配与来源清单

[Hugging Face Datasets Loading 官方文档](https://huggingface.co/docs/datasets/loading)提供 CSV、JSON/JSONL、Parquet、文本及本地/远程文件加载；`data_files` 可映射 split，Hub 数据可通过 branch、tag 或 commit revision 固定。JSONL 每行一个对象是推荐的高效结构，嵌套 JSON 还可能需要指定包含记录的 field。

其 `DatasetInfo` 可记录 description、features、splits、checksums、license、版本和大小等信息。[DatasetInfo API](https://huggingface.co/docs/datasets/package_reference/main_classes#datasets.DatasetInfo)说明了这类 source manifest 应包含的元数据。Hub Dataset 仓库本身具有 Git/Xet 修订历史，并可用 Dataset Card 记录 license、语言、来源和限制。

EvalBase 应借鉴：

- HF 来源登记保存 repo、config、split、revision/commit、license 和取得时间。
- 本地导入记录格式、编码、推断 Schema、行数、文件哈希和解析器版本。
- 解析失败应产生可下载的错误报告，不应破坏或替换原始字节。
- 筛选、`select`、`filter`、`map` 等可作为外部策展/处理方案的表达参考。[Processing 官方文档](https://huggingface.co/docs/datasets/process)

[HF Datasets Cache 官方文档](https://huggingface.co/docs/datasets/about_cache)说明 fingerprint 会把当前 Arrow 状态与 transform 哈希结合；无法 hash 的 transform 可能产生随机 fingerprint。它服务计算缓存，不是稳定的业务版本或审计 ID。`load_dataset` 转换得到的 Arrow 数据也不能代替原文件原样保存。

## 12. lakeFS：已评估但不列为 MVP 核心参考

lakeFS 提供对象存储上的 Git-like branch、commit、merge、revert 和 tag，commit 是不可变快照，适合大规模数据湖。[官方开发文档](https://docs.lakefs.io/dev/)和[数据结构说明](https://docs.lakefs.io/latest/understand/data-structure/)展示了逻辑路径与不可变物理对象的分离。

但它需要对象存储和元数据数据库，解决的是对象/目录级版本与隔离，不提供用例级派生、Prompt/Operator 血缘或人工复核。对于第一版 CSV/JSON/JSONL 测试数据管理过重。未来进入大规模对象存储或多分支数据湖协作时再评估；不要为了“像 Git”提前引入分支、合并和冲突解决复杂度。

## 13. 对 EvalBase 领域模型的直接影响

本节是从一手资料推导出的设计结论，不是对任何单一产品的复制。

| EvalBase 对象 | 最小职责 | 关键不可变证据 |
| --- | --- | --- |
| Data Asset / Raw Asset | 保存原始或外部处理后的完整内容 | blob hash、大小、media type、原文件名、来源说明、取得人/时间、外部 revision/license |
| Parsed View / Source Record | 通过统一读取契约解析资产并提供可定位记录 | parser/version/config、schema profile、错误；asset ID + row locator/JSON Pointer + content hash；保留源结构与原值 |
| Curation Recipe / Working Draft | 描述筛选、抽样、手工包含/排除、字段映射 | 有序步骤、表达式、seed、mapping schema、未映射字段处置 |
| Candidate Snapshot | 将草稿在某一时刻物化为不可变待审对象 | 输入资产/版本、recipe snapshot、record manifest、计数和校验结果 |
| Test Set / Test Set Version | 长期身份与一次不可变发布 | 版本号、父版本、candidate ID、schema snapshot、item manifest hash、发布人/时间/说明 |
| Test Case / Revision | 跨版本稳定身份及某版本中的内容 | input、expected_output、business metadata、origin refs、content hash |
| Transformation Run | 登记外部清洗、改写、抽取、扩写或人工修订 | purpose、tool/code、operators、prompt、model、params、input/output、actor、status、timestamps |
| Review Decision | 保存人与机器不同的判断 | reviewer、subject、decision、comment、timestamp；可关联 suggestion，但不能覆盖它 |
| Delivery Record | 固定版本到文件或 Langfuse 的一次交付 | target、mapping version、manifest、external IDs、remote timestamp、status、counts/errors |
| Audit Event | 谁对什么做了什么 | append-only actor/action/entity/before/after/request/time/result |
| Lineage Edge | 哪个对象产生哪个对象 | typed input/output edge + recipe/run ID |

### 13.1 最小可行血缘

MVP 不必一开始做列级血缘图，但必须同时满足：

- **版本级**：每个候选快照/测试集版本能指向所有直接上游资产、父版本和策展/处理运行。
- **用例级**：每个 Test Case Revision 至少能指向原始 `asset_id + stable locator + source content hash`，或指向父用例修订；人工新建则记录创建人、时间和用途。
- **运行级**：每次物化、外部处理和同步保存输入、输出、完整参数快照与状态。

仅保存行号不够稳定：CSV 重排后行号会改变；JSON/JSONL 也可能重新序列化。应组合资产哈希、文件内 locator（行号或 JSON Pointer）、源记录内容哈希和可选外部主键。

### 13.2 人审侧链

借鉴 Argilla，但保持 MVP 简洁：

```text
Source/Test Case Revision
  ├─ Machine Suggestion（可有多个，含 agent/model/score）
  ├─ Human Response / Edit（可有多个，含 user）
  └─ Review Decision（是否允许进入候选/发布）
```

机器 Suggestion、人工 Response 与最终 Review Decision 必须是不同对象。第一版若不做多人审批，也应至少保存“谁确认了哪个候选快照、依据哪次校验、何时发布”。

## 14. PRD 应固化的产品规则

1. **上传优先于建模。** 用户选择 CSV/JSON/JSONL 后，系统先保存原始字节和来源说明，再异步解析、推断字段和展示预览。
2. **原件不统一，读取统一。** 不强制转换文件、扁平化字段或改写原值；格式适配器统一输出带资产引用、稳定 locator、源结构、记录哈希和解析状态的 Source Record。
3. **类型推断不等于类型转换。** 推断结果只作为旁路提示；转换必须是策展方案中的显式步骤。
4. **查询缓存不是真源。** Arrow/Parquet 等内部表示必须绑定资产哈希、解析器版本和配置，可丢弃、可重建，不能被版本或血缘直接引用。
5. **原件永不被映射或清洗覆盖。** 任何筛选、改写、扩写结果都是派生对象；解析视图自身只是可重建读取结果。
6. **工作态与发布态分离。** Working Draft 可变；Candidate Snapshot 与 Published Test Set Version 不可变。
7. **发布后修改一律派生新版本。** 新版本显式指向父版本并提供新增、删除、修改差异。
8. **映射必须可预览、可校验。** `input / expected_output / metadata` 的实际 JSON 结构在物化前预览；未映射字段必须显示并由用户确认处置。
9. **筛选和抽样必须可重现。** 保存表达式、排序、seed、步骤顺序和输入快照；“随机抽 100 条”不能只保存结果描述。
10. **外部处理必须有清单。** 缺少工具/规则、Prompt/模型、输入输出引用、操作者或时间的处理结果不得宣称可完整追溯。
11. **复核状态若影响质量，必须成为门禁。** 避免 Easy Dataset 式“已确认但未确认也能导出”的模糊语义。
12. **血缘和审计分开。** 不能靠更新时间、备注或 Webhook 重建数据因果关系。
13. **标准版本与交付格式解耦。** JSONL 是本地正式内容；CSV 只服务 UI 人工导入；SDK/API JSON 服务自动同步。
14. **Langfuse 是交付目标，不是真源。** 本地保存版本、Schema、映射和交付 manifest；远端只登记稳定 ID 与完成时间戳。
15. **同步以成功交付记录为原子边界。** 远端可能产生多个中间版本；partial failure 不得成为可选的正式交付版本。
16. **评测结果保持独立。** actual output、Trace、Score 和报告属于第二条产品线，Phase 1 只管理正式测试输入和 expected output。

## 15. 明确不应照搬的设计

| 来源 | 不应照搬 | 原因 |
| --- | --- | --- |
| Easy Dataset | 一个 Project 包揽来源、生成、数据集、评测；确认不阻断导出 | 边界过大，发布语义不可靠，缺强版本模型 |
| Argilla | 先建 Settings，再导入并映射 Records | 与 raw-first 目标相反；用户尚未看到数据就必须理解 Schema |
| Argilla | 以 Record 原地更新和 Webhook 代替版本/审计 | 无法稳定重现已发布评测输入 |
| Lilac | 直接依赖其代码；把标签、Signal、删除标记当版本 | 仓库已归档；工作状态不等于不可变发布版本 |
| DataFlow | 把 step cache 当版本；允许覆盖输入字段；在 MVP 内建完整执行器 | cache 只为恢复，覆盖破坏审计，执行器会使范围失控 |
| Langfuse | 直接把 CSV uploader 当导入层；把时间戳版本当唯一版本 | 未映射列会忽略；Schema 不版本化；不保存 raw source 和完整血缘 |
| DVC | 强迫产品用户理解 Git、CLI、branch 和文件级 pipeline | 不覆盖 Record 策展、人审和用例级来源，交互成本高 |
| HF Datasets | 以 Arrow cache/fingerprint 作为正式版本或原件 | fingerprint 可能随机，cache 生命周期与审计生命周期不同 |
| OpenLineage | 一开始实现完整协议、列级血缘和外部服务 | 标准本身不存数据、不审核；MVP 的版本级 + 用例级来源已经足够 |
| lakeFS | 第一版引入对象存储分支/合并系统 | 基础设施过重，且仍不能解决 Record、Prompt 和人审语义 |

## 16. 资料索引

### Easy Dataset

- [官方 GitHub 仓库](https://github.com/ConardLi/easy-dataset)
- [官方产品介绍](https://docs.easy-dataset.com/ed/en)
- [数据集管理](https://docs.easy-dataset.com/shu-ju-ji/shu-ju-ji-guan-li)
- [数据集导出](https://docs.easy-dataset.com/ed/en/datasets/dataset-export)
- [Prisma 数据模型](https://github.com/ConardLi/easy-dataset/blob/main/prisma/schema.prisma)
- [官方 Releases](https://github.com/ConardLi/easy-dataset/releases)

### Argilla

- [Dataset](https://docs.argilla.io/latest/how_to_guides/dataset/)
- [Record](https://docs.argilla.io/latest/how_to_guides/record/)
- [Annotation UI](https://docs.argilla.io/latest/how_to_guides/annotate/)
- [Query and Filter](https://docs.argilla.io/latest/how_to_guides/query/)
- [Import and Export](https://docs.argilla.io/latest/how_to_guides/import_export/)
- [Webhooks](https://docs.argilla.io/latest/how_to_guides/webhooks/)

### Lilac（历史官方资料）

- [归档的 databricks/lilac 仓库](https://github.com/databricks/lilac)
- [历史官方文档](https://docs.lilacml.com/)
- [Quick Start](https://docs.lilacml.com/getting_started/quickstart.html)
- [Python API Quick Start](https://docs.lilacml.com/getting_started/quickstart_python.html)
- [Signals](https://docs.lilacml.com/signals/signals.html)
- [DatasetConfig API](https://docs.lilacml.com/api_reference/index.html)

### OpenDCAI/DataFlow

- [官方 GitHub 仓库](https://github.com/OpenDCAI/DataFlow)
- [Framework Design](https://opendcai.github.io/DataFlow-Doc/en/guide/basicinfo/framework/)
- [First Pipeline](https://opendcai.github.io/DataFlow-Doc/en/guide/first_pipeline/)
- [Text Pipeline](https://opendcai.github.io/DataFlow-Doc/en/guide/textpipeline/)
- [New Operators](https://opendcai.github.io/DataFlow-Doc/en/dev_guide/new_algo/)

### 补充参考

- [Langfuse Datasets](https://langfuse.com/docs/evaluation/experiments/datasets)
- [Langfuse Experiments Data Model](https://langfuse.com/docs/evaluation/experiments/data-model)
- [Langfuse CSV Upload](https://langfuse.com/changelog/2025-01-27-Dataset-Items-csv-upload)
- [Langfuse API Limits](https://langfuse.com/faq/all/api-limits)
- [Langfuse Data Retention](https://langfuse.com/docs/administration/data-retention)
- [Langfuse Prompt Version Control](https://langfuse.com/docs/prompt-management/features/prompt-version-control)
- [DVC Get Started](https://doc.dvc.org/start)
- [DVC Pipeline Definition](https://doc.dvc.org/user-guide/project-structure/dvcyaml-files)
- [OpenLineage Object Model](https://openlineage.io/docs/spec/object-model/)
- [OpenLineage Facets](https://openlineage.io/docs/spec/facets/)
- [Hugging Face Datasets Loading](https://huggingface.co/docs/datasets/loading)
- [Hugging Face Datasets Cache](https://huggingface.co/docs/datasets/about_cache)
- [Hugging Face DatasetInfo](https://huggingface.co/docs/datasets/package_reference/main_classes#datasets.DatasetInfo)
- [lakeFS Documentation](https://docs.lakefs.io/dev/)
