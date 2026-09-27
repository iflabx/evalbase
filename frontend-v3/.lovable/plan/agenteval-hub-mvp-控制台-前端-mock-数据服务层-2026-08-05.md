# AgentEval Hub — MVP 控制台（前端 + Mock 数据服务层）

只实现 PRD 中冻结的 MVP 闭环，不做 Text2SQL / 意图识别 / 实体提取 / 工具调用计算器，不做控制 Agent。

## 闭环一：数据集管理
- `/datasets` 列表：数据集、当前版本、样本数、状态。
- `/datasets/new` 五步向导：文件导入（CSV/JSONL 拖拽）→ 字段映射（源列 ↔ question / expected_output / metadata）→ 数据预览（分页表格）→ 校验（字段级错误清单、必填缺失、类型不符、行号定位）→ 固化版本（生成不可变 `v1`、内容哈希、只读提示）。
- `/datasets/$id` 详情：版本时间线、样本表、版本对比入口、发布记录。

## 闭环二：发布到 Langfuse
- 版本详情内「发布到 Langfuse」：选择 Langfuse 项目 / Dataset 名称 → 幂等提示（同版本重复发布）→ 发布任务。
- 发布状态页：排队中 / 运行中（进度条）/ 部分成功（逐条失败原因表）/ 成功（外链 Langfuse）/ 失败（重试）。
- 明确语义提示：`expectedOutput` 只写期望答案，不写模型输出。

## 闭环三：导入已完成 Experiment
- `/imports/new`：连接 Langfuse 项目 → 拉取「已完成」Experiment 列表（可搜索、显示 item 数 / score 数 / 完成时间）→ 预检（字段覆盖率、缺失维度、量表识别）→ 导入运行中 → 固化为不可变 `evaluated_result` 版本。
- `/imports` 列表 + 详情：来源项目、Experiment ID、样本数、Trace/Observation/Score 覆盖率、失败条目。

## 闭环四：端到端七维计算与报告
- `/runs/new`：选择 evaluated_result 版本 → 选择计算器版本（e2e-quality v1）→ 量表 3 级（1 / 0.5 / 0）或 5 级（1 / .75 / .5 / .25 / 0）→ 七维权重编辑（默认 信息效率0.10、专业性0.20、准确性0.30、时效性0.15、相关性0.10、吸引力0.05、连贯性0.10，校验合计=1）→ 参数快照确认 → 提交。
- `/runs/$id` 报告页：
  - 总览：总分卡、参数快照、状态、有效/失败/跳过样本数。
  - 七维得分：条形图 + 表格（维度分、有效分母、缺失率，缺失显示 N/A 而非 0）。
  - 人机对比区：Pearson / RMSE / MAE / 配对 t 检验（样本不足时显示 N/A + 原因）。
  - 延迟：总延迟与阶段 Mean/P50/P95。
  - 样本明细：输入、期望输出、实际输出、各维评分与 Reason、Trace 外链，支持筛选与下钻抽屉。
  - 导出：CSV / JSON 下载（前端生成）。

## 状态覆盖
每个页面统一走 `<StateView>` 封装：加载骨架、空数据、校验失败、运行中、部分成功、失败、成功。

## 技术方案
- TanStack Start 路由 + TanStack Query；loader 用 `ensureQueryData`，组件 `useSuspenseQuery`。
- 数据服务层 `src/services/`：`datasets.ts`、`langfuse.ts`、`imports.ts`、`runs.ts`，统一 async 接口（含人为延迟与可切换的错误/部分成功场景）；mock 固定数据放 `src/services/mock/*.ts`。页面组件不含任何硬编码数据，后续可整体替换为真实 API。
- 七维计算公式在 `src/lib/e2e-calculator.ts` 中真实实现（映射→维度分→加权总分），对 mock 样本实算，方便后续接后端复用口径。
- 类型集中在 `src/types/`（Dataset、DatasetVersion、PublishJob、ImportJob、EvaluatedResultVersion、CalcRun）。
- 共享布局：`__root.tsx` 侧边导航（数据集 / 发布 / 导入 / 计算运行），语义化 design token，中文界面，数据密集型深色控制台风格；`/` 重定向到 `/datasets`。
- 每个路由独立 `head()` 元数据。
- 本次不接入 Lovable Cloud、不调用真实 Langfuse API。
