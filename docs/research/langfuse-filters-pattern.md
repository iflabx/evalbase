# Langfuse Filters 模式调研

| 项目 | 内容 |
| --- | --- |
| 调研日期 | 2026-09-08 |
| 调研问题 | EvalBase 的数据集/测试集筛选是否应借鉴 Langfuse Filters |
| 资料范围 | 仅 Langfuse 官方仓库；源码固定到 `b2ed6435e263caa7a9836303befe0b355e6c0a3b` |
| 文档效力 | 研究证据与建议，不修改现行产品合同 |

## 结论

Langfuse 的 Filters **适合借鉴交互模式和类型化合同，不适合整套照搬**。对单人数据集工具，推荐保留普通搜索，再增加一个渐进展开的“筛选”入口：选择字段、选择与字段类型匹配的操作符、填写值；已生效条件显示为可单独删除的标签，并提供“一键清除”。第一版只需支持常用固定字段和少量 Metadata 键，所有条件使用 `AND`。

Langfuse 的完整实现同时服务 traces、observations、sessions、scores、动态 metadata、PostgreSQL 和 ClickHouse，包含大量 EvalBase 当前不需要的耦合。直接复制会把一个小功能变成新的筛选框架。

## 已验证事实

| 方面 | Langfuse 当前实现 | 一手来源 |
| --- | --- | --- |
| 数据模型 | 筛选是判别联合：每项含 `column`、`type`、`operator`、`value`，对象字段还含 `key`；运行时由 Zod 校验。 | [`filters.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/interfaces/filters.ts) |
| 字段类型 | 支持 datetime、string、number、枚举多选、数组多选、对象内 string/number/boolean、boolean、null，以及 trace 位置等专用类型。 | [`filters.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/interfaces/filters.ts) |
| 操作符 | 文本支持等于、包含、不包含、开头、结尾、非空；多选支持 any/none/all of；数字和日期支持比较；空值支持 is null/is not null。事件表另有全文 `matches`。 | [`filters.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/interfaces/filters.ts) |
| UI 交互 | 表格工具栏接入筛选按钮/侧栏；旧式 builder 用弹层逐行选择字段、操作符和值，已应用条件渲染为 FilterToken，可增加、单删和清空。 | [`data-table-toolbar.tsx`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/components/table/data-table-toolbar.tsx), [`filter-builder.tsx`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/features/filters/components/filter-builder.tsx) |
| 状态持久化 | 筛选编码进 `filter` 查询参数，同时按 table/project 镜像到 sessionStorage；刷新可恢复，同项目内不同表可隔离。编码前后都会根据已知列和 Zod 合同过滤无效条件。 | [`useFilterState.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/features/filters/hooks/useFilterState.ts), [`filterQueryEncoding.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/features/filters/filterQueryEncoding.ts) |
| URL 上限 | 通用编码器把 URL 中的筛选串预算限制为 4,000 字符；更大的状态只保留 sessionStorage，避免刷新/分享链接触发过大请求头。 | [`filterQueryEncoding.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/features/filters/filterQueryEncoding.ts) |
| 后端翻译 | PostgreSQL 路径先用列定义把公开列名映射到内部列，再按已验证类型生成参数化 Prisma SQL；多项条件固定以 `AND` 连接。 | [`filterToPrisma.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/server/filterToPrisma.ts) |
| ClickHouse 路径 | 各类型由独立 filter class 生成查询和命名参数，处理空值、数组、对象键和全文搜索等数据库细节。 | [`clickhouse-filter.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts) |
| 动态选项 | 实验条目的 score 筛选选项由后端按 experiment IDs 查询，并按 numeric/boolean/categorical 分类后提供给 UI。 | [`useExperimentItemsFilterOptions.ts`](https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/features/experiments/hooks/useExperimentItemsFilterOptions.ts) |

## 对 EvalBase 的建议

以下是建议，不是 Langfuse 的既有事实。

### 推荐借鉴

1. **搜索与筛选分工**：搜索继续处理“我记得一段文字”；筛选处理“状态是某值、来源是某文件、更新时间在某范围”等结构化条件。
2. **类型驱动控件**：文本用输入框，状态/来源用可搜索多选，日期用起止日期；不要让用户填写操作符文本。
3. **筛选标签**：应用后在列表上方显示如“来源文件：a.csv”“状态：可浏览”的标签，可逐项删除并一键清除。
4. **固定 `AND` 语义**：第一版所有条件同时满足，界面直接表达“同时满足以下条件”，不加入嵌套 AND/OR。
5. **白名单后端合同**：API 接受结构化筛选对象；服务端只允许已声明的字段、类型和操作符，再使用参数化查询。不要把前端列名或 SQL 片段直接传入数据库。
6. **刷新保持**：少量条件放进 URL，便于刷新后保留和复制当前视图；无需照搬 sessionStorage 双写，除非实际出现超长 URL 或跨页面恢复需求。

### 建议的最小范围

| 页面 | 第一批筛选 |
| --- | --- |
| 数据集列表 | 状态、更新时间 |
| 数据集文件列表 | 文件类型、解析状态、更新时间 |
| 统一记录浏览 | 来源文件、是否包含 Metadata；保留全文搜索 |
| 测试集列表 | 状态、更新时间 |
| 测试集版本记录 | 来源文件、变更类型（新增/修改/删除）；保留全文搜索 |

只有当用户确实反复按某个 Metadata 键查找时，才把该键加入筛选字段。第一版不提供任意 JSONPath、任意 Metadata 键发现或保存筛选模板。

### 不建议照搬

- 不复制 Langfuse 的 trace/session/observation、score level、environment 或 position-in-trace 专用筛选。
- 不引入 ClickHouse 筛选实现、全文索引优化、AI 生成筛选、系统/用户筛选预设或动态列可见性框架。
- 不实现嵌套条件组、任意 `OR`、任意数据库字段、任意对象路径或复杂语法栏。
- 不直接复制源码组件：它们依赖 Langfuse 的表格定义、路由状态、分析事件、UI 组件和后端类型。应复用“类型化条件 + 标签式交互 + 白名单翻译”这一设计，而非代码本身。

## 复杂度判断

如果 EvalBase 当前只有单一搜索框，那么它对“按来源、状态、格式、日期和变更类型缩小结果”确实偏简单；但这不意味着需要 Langfuse 的完整 Filters。最合适的升级是 **搜索框 + 3 至 5 个高频结构化筛选字段**。先从实际列表字段开始，待出现真实高频需求后再扩充，能在明显改善查找效率的同时避免重新把单人产品做复杂。

## 来源

- Langfuse 官方仓库固定提交：<https://github.com/langfuse/langfuse/tree/b2ed6435e263caa7a9836303befe0b355e6c0a3b>
- 筛选合同：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/interfaces/filters.ts>
- 筛选编码：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/features/filters/filterQueryEncoding.ts>
- 查询参数与会话状态：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/features/filters/hooks/useFilterState.ts>
- 筛选构建器：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/web/src/features/filters/components/filter-builder.tsx>
- PostgreSQL 转换：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/server/filterToPrisma.ts>
- ClickHouse 转换：<https://github.com/langfuse/langfuse/blob/b2ed6435e263caa7a9836303befe0b355e6c0a3b/packages/shared/src/server/queries/clickhouse-sql/clickhouse-filter.ts>
