# 保存目标修改完成核对与恢复补修

日期：2026-10-30。分支 codex/assistant-rebuild；主实现 42b537f。方案见[审查后方案](../result-workspace-20261029/verification.md#amendment-completion-plan)（链接按服务器证据目录解析）。本文件作为服务器 `.scratch/assistant-rebuild/amendment-completion-20261030/verification.md` 的本地副本。

## 实现与定向证据

- 明确保存名称命令在消息受理事务内记录独立持久事件；参数纠错、旧暂停快照、查询和重启不清除。修改完成与真实业务要求同事务核对交付身份、目标名称和基础修订；允许同名幂等、明确撤销和新指令替代。
- 复用唯一 update_requirements 工具和既有受保护提交；模型漏调用时最多一次持久记账的补调用。请求/时间/无进展保护仍使用原账本，普通继续不增加额度。
- 处理、恢复、准备确认及确认消费检查未完成修改；旧卡失效。投影和查询明确待改名称及原因。兼容处理 run 的解析从原执行方法抽出共用，防止保存后仅改展示名推进修订就绕过已保存保护。
- 新公开 HTTP 消息→自动派发→真实 SDK/受控 HTTP 模型回归覆盖首轮零工具调用后补改名、保持暂停、继续、新卡、旧卡拒绝、重复确认唯一保存，以及保存后兼容修订不能再次另存。增加失败后查询、新 Host 恢复阻断、明确撤销和否定/查询不产生写义务。
- 20 项定向回归通过，96 项未运行；类型检查、变更源码 ESLint、diff 检查通过。未运行全仓库套件。原零工具遗漏的红测试在要求未生效处超时；失败保留。新增失败边界测试首次因没有显式断言预期异常而失败，改为检查拒绝及持久事实后通过。
- Standards/Spec 定向复审发现并关闭基础修订遗漏、待改投影遗漏、按当前修订判断已保存的遗漏。均按实际业务身份保护，无自动重基。

## 新有界 Computer Use

活动 amendment-completion-20261030；独立新会话 assistant_ac8ac3c9904d4fa387754e806ba01cf6，项目 project_c0051e3cde404aad861d60c064e1ae08。GPT-6.1 Terra high 决定操作，主代理中继侧栏 IAB；无用户接管、技术参数提示或重复改名澄清。

上限 24 请求/4 处理行次/0 生成/25 分钟。实际 18 请求（17 助手、1 Worker）、2 处理行次、0 生成；UTC 2026-10-29 16:40:28.190～16:47:08.756，约 6 分 40 秒，活动已封存。

普通提示清洗合成文件前两条→等待保存确认→点击停止→一次“只把保存名称改成……先不要继续”→查询→普通“继续”→新确认卡→单次保存→查询名称数量→真实草稿预览及展开 Metadata。

| 检查 | 实际结果 |
| --- | --- |
| 首次改名遗漏恢复 | 实模首次漏调用，服务端一次补调用后真实名称生效，无需用户重复要求 |
| 保持暂停与查询 | 未擅自继续，查询明确已处理未保存及新目标 |
| 恢复与新卡 | 普通继续成功；旧初稿卡 expired/revision 1，新终稿卡 committed/revision 2 |
| 唯一保存 | 一个 run processing_e93d8711432e4226b446a7870031bb42，一个成功采用、一个草稿 collabdraft_e5b9807903fb44ff8cc556de2f27e589，名称“改名机制终稿”，2 条 |
| 内容与预览 | 两问题、答案标签、Metadata L01/查询与 L02/预约正确；真实表格、标题、条数及完整草稿链接一致 |
| 保护 | 原始文件 hash 保持；19 张表既有行和全部旧预算原值保持；不重跑通过的 C01/C02 |

## 实模暴露的追加补修与结论限制

业务闭环完成，但本次不能标为无报错通过：自动补调用提交成功后，宿主 requiredAmendmentTool 仍保持 update_requirements，导致再次请求继续强制该工具，发生三次同值修改并触发 no_progress。真实改名已提交，后续查询、继续和唯一保存正常，历史失败保留。

追加修复在 tool_result 后以持久待改状态核对完成，及时解除临时强制工具；仍有未完成修改则不解除，既有参数纠错优先级保持。补真实 SDK 请求断言：完成后下一次 Provider 请求不得仍强制 update_requirements。初版把断言放在模型服务回调里会被该夹具转换为 HTTP 500，不能算有效红测；修为回调只记录、测试主体断言，原实现明确红（预期 false、实际 true），补修后绿。

追加补修已通过原 20 项组合及独立最终 SDK 断言、类型与 lint 检查。后续隔离预览更新使用补修提交，部署身份见 preview-version.json。本次实模发生在追加补修之前；没有另开活动或重置旧预算，因此不宣称追加补修已取得新一轮无报错实模证明。停止发生于等待确认阶段，不冒充 Worker 在途暂停。

证据同目录：red.log、final2.log、forced-tool-red2.log、forced-tool-green.log、forced-tool-final.log、types-last.log、lint-last.log、C04-ledger.json、business-result.json、inspect.json、preservation.json、preview-version.json。本地截图 workspace-cu.png。

后续独立验证：Owner另开授权活动在6be6ded完成同场景CU，未出现no_progress，见[新活动验收](../amendment-retest-20261030/verification.md)。本活动原有警告及预算保持，不据后续结果改签。
