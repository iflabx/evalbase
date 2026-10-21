# 首批五个独立会话 Computer Use 验收记录

日期：2026-10-21（Asia/Shanghai）。结论：1例通过、4例未通过；需要生成的4例均未到达生成/采用，不宣称生成闭环通过。

## 环境与边界

- 用户授权前5例，逐例一个独立新会话，仅普通提示；没有业务代码修改或调参，没有扩大到后15例。
- 侧栏内置浏览器已恢复可用。使用同应用代码0b871335e6e19832cb345cbee8d85541f42cf77d、模型qwen-new；仓库HEAD为文档提交37cc4f9。
- 原4220独立验证已有自己的旧账本；本轮另建4222回环入口、独立数据库和一个合成测试项目，以免把请求计入旧预算。所有发言、新建会话、重试及刷新均从真实浏览器UI执行。只读快照用于核对后台事实，不通过API发送用户提示或伪造工具结果。
- 固定上限每例20次真实模型HTTP请求、累计模型活动300000ms；整批100次/1500000ms/最多16条生成请求。每次参数修复、协议修复及重试均计数。各例生成请求上限2/4/0/3/4；保护性拦截0次，无重置或换会话绕过。
- 项目project_3a2d3ba3f90940b8a6d555128885f9dd；数据库batch1_c663bd18c92446f3be880890d57c2ce6。本轮未上传文档，按前5例自然语言方案执行。

## 逐例结果

| 例 | 场景 | 结果 | 请求数 | 模型活动秒 | 请求生成条数 |
|---|---|---|---:|---:|---:|
| 1 | 模糊需求与连续澄清 | 未通过 | 7 | 60.888 | 0 |
| 2 | 两个测试集普通确认执行 | 未通过 | 5 | 94.470 | 0 |
| 3 | 先讨论再记录，禁止生成 | 通过（本例仅讨论和记录要求） | 4 | 23.272 | 0 |
| 4 | 连续修改数量后执行 | 未通过 | 7 | 35.970 | 0 |
| 5 | 中途替换测试集主题 | 未通过 | 5 | 15.777 | 0 |

### 1：模糊需求与连续澄清

- 会话：conversation_d32d8354ccbe48dc911a17112c7e4bf6。
- 实际普通提示：
  - 帮我做一份客服测试集。
  - 电商客服，先做2条。
  - 查物流的，其他你安排。
- 实际结果：三句普通提示后报assistant_requirements_not_saved；页面重试一次仍失败。要求部分落盘，但updateSaved=false、执行步骤为空，无法完成生成。
- 用户额外操作：首次失败后点击一次“重试未完成步骤”；再次失败即停止，没有技术提示。
- 最终状态：failed；错误：assistant_requirements_not_saved。
- 自动纠错记录：
  - turn_eecab58194d9424db87a7ba79b18255b：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_e215caa35e2f4c3d878033b8cbef25a8：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_633ed6cad2b24ee2bd672b0dd1cf8707：状态failed；工具错误assistant_tool_input_invalid；协议纠正0；参数修复[]。
- 截图：batch1-side-browser/case1-final.png（本地；第1例另有first-failure截图）。

### 2：两个测试集普通确认执行

- 会话：conversation_f889a35ba70a4569902350255052fb62。
- 实际普通提示：
  - 帮我做两个电商客服测试集：查物流和改地址，各2条。先给方案，我确认后再做。
  - 可以，开始吧。
- 实际结果：初始回复只要求用户确认，未保存完整交付步骤；“可以，开始吧”后参数失败、纠正被意图守卫拒绝，约80秒本轮截止。回复仍声称已开始生成，实际零处理任务。
- 用户额外操作：无追加技术提示或手动重试。
- 最终状态：failed；错误：assistant_budget_exhausted。
- 自动纠错记录：
  - turn_f89f0fc8aad9465591fdb524355374cb：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_0ce8f556d1cd4a3ab74ed6955a416cae：状态failed；工具错误assistant_tool_input_invalid、assistant_intent_required；协议纠正1；参数修复[]。
- 截图：batch1-side-browser/case2-final.png（本地；第1例另有first-failure截图）。

### 3：先讨论再记录，禁止生成

- 会话：conversation_326dd66036f340b2ba9345e8a70564fa。
- 实际普通提示：
  - 我想做查物流的测试集，先聊聊怎么设计，别生成。
  - 如果也要测修改地址，应该怎么分？
  - 好，就这两类，各2条，先把方案记下来。
- 实际结果：两轮业务讨论正常，第三轮记录总数4、查物流/修改地址各2的配额与具体要求。刷新后要求保留；零草稿、零处理任务、零生成拦截。本例不验证可执行交付步骤或生成闭环。
- 用户额外操作：无追加技术提示或手动重试。
- 最终状态：planning；错误：无。
- 自动纠错记录：
  - turn_10748f70d04b40bbb63adaacfc316a8f：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_5d35aac3de2646ef82180a24bfd6c0d1：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_cabc1ef048764afa81f2ac651977b6da：状态succeeded；工具错误无；协议纠正0；参数修复[]。
- 截图：batch1-side-browser/case3-final.png（本地；第1例另有first-failure截图）。

### 4：连续修改数量后执行

- 会话：conversation_ee5db1643b434e72a4215827613f81d5。
- 实际普通提示：
  - 查物流和改地址，各做2条，先别执行。
  - 查物流改成3条。
  - 算了，查物流还是2条，改地址只要1条。
  - 按最后这个做。
- 实际结果：首次期望输出分类校验失败后同轮改为Metadata并保存。改3条时deliveries缺name连续失败；改2+1时新配额与旧总数4冲突两次。最后“按最后这个做”保存总数3，但control仍为plan，保留“仅保存方案、不执行生成”，零执行。
- 用户额外操作：无追加技术提示或手动重试。
- 最终状态：planning；错误：无。
- 自动纠错记录：
  - turn_597abe3ace7f44e2aa29b39c3ffa1c7c：状态succeeded；工具错误assistant_background_rule_mismatch；协议纠正0；参数修复[]。
  - turn_c8f987cacff244c7831aa5820c9c0b20：状态failed；工具错误assistant_tool_input_invalid、assistant_tool_input_invalid、assistant_tool_input_invalid；协议纠正0；参数修复[{"name":"plan_task","outcome":"context_required"},{"name":"plan_task","outcome":"context_required"},{"name":"plan_task","outcome":"context_required"}]。
  - turn_1a8cc7f809844d598a62c77a6d246800：状态failed；工具错误assistant_plan_count_conflict、assistant_plan_count_conflict；协议纠正0；参数修复[]。
  - turn_c4cbe2b491294078a41a85d020e03e74：状态succeeded；工具错误无；协议纠正0；参数修复[]。
- 截图：batch1-side-browser/case4-final.png（本地；第1例另有first-failure截图）。

### 5：中途替换测试集主题

- 会话：conversation_72a8d30404504ab590d644c3a9d03924。
- 实际普通提示：
  - 做查物流和改地址两个测试集，各2条，先给方案。
  - 改地址不要了，换成退款进度。
  - 现在开始。
- 实际结果：主题名称从改地址变为退款进度，仍连续追问业务背景。用户发送“现在开始”后target结构失败；两次参数纠正被判unsafe，最终exhausted。未生成原主题或新主题，主题替换后的生成/保存未覆盖。
- 用户额外操作：无追加技术提示或手动重试。
- 最终状态：failed；错误：assistant_tool_input_invalid。
- 自动纠错记录：
  - turn_ca60fe7f6c414e0eacaef692d7f51550：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_325d95e15ac64c10a8b28fc1fc110498：状态succeeded；工具错误无；协议纠正0；参数修复[]。
  - turn_7366e2f061de4df7869f21b71818d5f8：状态failed；工具错误assistant_tool_input_invalid；协议纠正0；参数修复[{"name":"plan_task","outcome":"unsafe"},{"name":"plan_task","outcome":"unsafe"},{"name":"plan_task","outcome":"exhausted"}]。
- 截图：batch1-side-browser/case5-final.png（本地；第1例另有first-failure截图）。

## 报错与自动纠正观察

1. 第1例同一轮出现工具成功回执与最终“要求未保存”并存。持久要求虽有更新，turnControl.updateSaved仍false；需后续定位标记与收口条件，不据此声称完全没写数据库。
2. 第2例生成前出现虚构的targetDraftId、遗留question与nextAction冲突；纠正再触发assistant_intent_required。存在一次协议修复。首个执行请求等约59.5秒，纠正后触及应用本轮80秒截止；不是本批每例5分钟或20次上限耗尽。assistantText声称已开始，真实运行数为0，提示与事实不一致。
3. 第3例额外模型调用属于正常步骤，未记录协议或参数纠错；不能按“调用多于工具次数”推断发生纠错。
4. 第4例有一次分类字段错误在同一轮成功纠正。但后续缺字段修复连续context_required，数量更改未同时更新总数；最终数量恢复正确，执行意图仍被旧“先别执行”污染。
5. 第5例参数修复unsafe两次并exhausted一次，自动纠错没有使本轮恢复。改主题标题可见，但requirements里仅有整体数量，不能认定新交付完整保存。

以上为实测观察和持久证据，未完成代码级根因分析，不能归结为单一模型问题。此前附件固定流程的小样本通过不能覆盖本批无附件、模糊需求及多轮变更。

## 消耗、保护与证据

- 实际28次模型HTTP请求、230377ms累计模型活动，生成请求0条，处理任务0、草稿0、采用0、发布0。没有生成调用被预算拦截。
- 结束时5个会话均无running/queued轮次。第3/4例保留planning，第1/2/5例保留失败；所有失败保留。
- protection-before/after核对7份旧预算哈希一致，15张Owner业务表内容指纹一致。原验收数据保持。
- 原始证据：batch1-side-browser/semantic-budget.json、semantic-results.json、ui-prompts.json、protection-before.json、protection-after.json。截图和临时测试限额驱动单独保留，不提交私有凭据或数据库。
- 第1例UI重试复用原turn，因此最终turn快照包含重试后的诊断；首次失败另有截图及UI事件记录，不能仅用最终turn覆盖首次失败事实。
- 未执行后续测试、未修改业务代码、未重新生成旧成果。
