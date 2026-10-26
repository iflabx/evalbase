# 本轮逐项结果

| 样本 | 结论 | 末端结果 | 实际请求 |
| --- | --- | --- | --- |
| L01 | passed | passed | 3 |
| L02 | blocked | passed-after-infrastructure-restoration | 5 |
| CU-A1 | passed | passed | 4 |
| CU-B1 | passed | passed | 6 |
| CU-C1 | failed | failed | 5 |
| CU-D1 | failed | saved-8-but-source-link-failed | 6 |
| CU-A2 | passed | passed | 4 |
| CU-B2 | passed | passed | 6 |
| CU-C2 | incomplete | saved-5-but-inflight-stop-uncovered | 7 |

仅4项普通样本完整通过；没有用已保存替代完整验收。L02保留环境介入；CU-C1恢复失败；CU-D1来源跳转失败；CU-C2在处理完成后停止，且出现重复回执展示。

原始材料字节、全部6条source_record和旧预算哨兵文件校验未变。实际50/120次请求、37/50行次、8/12生成槽位；已封存，无在途模型调用或活动作业。

详细原始请求、原响应/注入响应、事件、检查点ID、确认与业务回执见 [audit.json](audit.json)，保护字段逐值核对见 [business-checks.json](business-checks.json)。
