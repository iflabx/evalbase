# 确定性产物、分层哈希与离线校验

- Status: Accepted
- Date: 2026-08-18
- Amended: 2026-09-03
- Decision role: Project Owner / Sole Developer

Phase 1A 内部 JSON 使用 RFC 8785 canonical JSON，历史 `items.jsonl` 使用冻结 ordinal、UTF-8 无 BOM、LF 和末尾 LF。SHA-256 分别形成 blob/record/content、`payload_hash`、`evidence_hash` 和排除自身字段的 `version_manifest_hash`。这些规则继续保护内部版本身份与存储完整性，不能改变用户可见版本标签。

冻结 v5.2 原型把当前下载合同固定为数据 CSV，以及单独的数据 CSV + provenance CSV。Package、ZIP、公共离线校验器 CLI、Langfuse 交付和 Delivery 管理界面不属于当前产品，也不得从历史实现重新接入。两个 CSV 可在内部使用确定性序列化与独立 delivery hash，但这些技术事实不得增加原型外下载选项或用户步骤。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#58-csv-download)和[数据与版本不变量](../architecture/phase1a-architecture.md#6-数据与版本不变量)。
