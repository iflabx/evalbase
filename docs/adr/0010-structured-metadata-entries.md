# 结构化 Metadata 项与旧文本兼容

Status: Accepted

v5.2 要求浏览和编辑时保留 Metadata 的字段和值边界，因此新写入使用有序的 `{ key, value }` 项，字段名在同一记录内按不区分大小写唯一；上传映射以原始字段的显示名作为键。历史单文本 Metadata 不回写：读取、详情和 CSV 导出时把原值无损呈现为唯一的 `Metadata` 项。数据 CSV 的单个 Metadata 列以稳定的“字段：值”顺序呈现。这样保留旧版本、来源事实和 CSV 下载，同时不引入 Schema、类型系统、JSON 编辑器或任意键查询。
