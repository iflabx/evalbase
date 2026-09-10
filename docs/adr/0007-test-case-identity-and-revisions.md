# 测试用例身份与不可变修订

- Status: Accepted
- Date: 2026-08-18
- Decision role: Project Owner / Sole Developer

`case_id` 是持久化的不透明身份，不由内容哈希推导。父版本用例继承身份；新 Source Record 通过 `test_set_id + draft_source_id + source_record_ref + output_slot` 的唯一绑定原子分配 ID，使同一草稿重算幂等，而在未来草稿重新追加相同资产时仍按产品合同默认生成新身份。

用例修订不可变；只有内容和 lineage fingerprint 都未变化时才复用既有 `case_revision_id`，否则创建新修订。内容重复可以按 PRD 警告后保留，但跨测试集 ID 注入、一个绑定对应多个身份或 `case_id` 冲突必须阻断。

实施细节见 [Phase 1A 架构](../architecture/phase1a-architecture.md#6-数据与版本不变量)。
