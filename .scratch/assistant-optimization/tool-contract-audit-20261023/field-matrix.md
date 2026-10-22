# 全部工具参数逐字段核对表（2026-10-23）

基线 a4102b78545eaf11d1e8b782b127330c662ab43d；业务源码与2c74b8e一致。由15个真实businessTool声明和计划Schema派生逻辑抽取，90个顶层字段逐项人工核对；附全部399条字段路径（含计划action变体和复用结构的重复路径）。这不是399项已执行测试。

[审查结论](../../../docs/assistant-tool-parameter-review-2026-10-23.md)；[完整Schema](tool-schemas.json)保留if/then/else、oneOf、anyOf及数组元素约束。表中必填仅指该层required；条件必填须看完整Schema，不能把“否”理解为任意场景可省略。

共同入口：模型可省略可信上下文能补齐的字段；计划保存允许未来依赖缺省；执行先解码/绑定后固定校验；恢复仍受冻结身份、修订、范围与回执约束。参数变体及安全检查详见审查报告，未发现新增缺陷不等于端到端已验证。

## plan_task

源码：`src/assistant/agent.ts:2422`。固定执行必填：``；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `control` | 结构化控制；query禁止隐含修改/暂停，执行权与待保存要求共同校验。 |
| `baseRevision` | 修改绑定当前任务修订；动态增量合同补入，旧冻结合同不回写。 |
| `deliveries` | 新增/修改/删除按真实id区分；数量、场景、分类、question合并后校验；F01–F03、TP06。 |
| `removeRequirements` | 省略保留、空数组清除；remove仅撤销指定要求。拼接成处理instructions受8000限制，TP06。 |
| `title` | 任务标题非交付身份；长度40，不能用改名产生新预算。 |
| `executionMode` | plan/execute与control及当前授权核对，恢复不得提升权限。 |
| `steps` | 旧合同及非文档任务；14种action从真实工具派生，未来缺引用暂缓执行。正常保存已有抽样归一，TP08仅兼容风险。 |
| `requirements` | 省略保留、空数组清除；remove仅撤销指定要求。拼接成处理instructions受8000限制，TP06。 |
| `targetCount` | 当前数量/合计/新增或最终数分开，省略保留、允许null的字段才撤销；配额合并校验。 |
| `overallTargetCount` | 当前数量/合计/新增或最终数分开，省略保留、允许null的字段才撤销；配额合并校验。 |
| `countKind` | 当前数量/合计/新增或最终数分开，省略保留、允许null的字段才撤销；配额合并校验。 |
| `targetDraftId` | 真实来源与最终目标；target可null表示清除；final需可读草稿基数，不猜ID。 |
| `allowedLabels` | 固定输出标签与Metadata分类分开；背景引用、逐字段clear、配额和覆盖按完整要求校验。allowedLabels模型侧隐藏但旧服务端合同保留。 |
| `classifications` | 固定输出标签与Metadata分类分开；背景引用、逐字段clear、配额和覆盖按完整要求校验。allowedLabels模型侧隐藏但旧服务端合同保留。 |
| `target` | 真实来源与最终目标；target可null表示清除；final需可读草稿基数，不猜ID。 |
| `allowedFields` | 省略保留；allowedFields空数组为禁止修改；metadataKeys null撤销键限制、空数组不能被解释为全部。 |
| `metadataKeys` | 省略保留；allowedFields空数组为禁止修改；metadataKeys null撤销键限制、空数组不能被解释为全部。 |
| `nextAction` | 实际下一动作与真实澄清分开；失败要求不落库不能只口头确认；F10反馈投影。 |
| `question` | 实际下一动作与真实澄清分开；失败要求不落库不能只口头确认；F10反馈投影。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `control` | 否/条件 | `type="object"; additionalProperties=false; required=["mode"]` |
| `control.mode` | 是 | `enum=["query","plan","execute","pause"]` |
| `control.requiresUpdate` | 否/条件 | `type="boolean"` |
| `control.pauseFirst` | 否/条件 | `type="boolean"` |
| `control.explanation` | 否/条件 | `type="string"; minLength=1; maxLength=1000` |
| `baseRevision` | 否/条件 | `type="integer"; minimum=0` |
| `deliveries` | 否/条件 | `type="array"; maxItems=10` |
| `deliveries[].id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `deliveries[].name` | 否/条件 | `type="string"; minLength=1; maxLength=200` |
| `deliveries[].count` | 否/条件 | `type="integer"; minimum=1; maximum=10000` |
| `deliveries[].countKind` | 否/条件 | `enum=["new","final"]` |
| `deliveries[].instructions` | 否/条件 | `type="string"; minLength=1; maxLength=8000` |
| `deliveries[].scenarios` | 否/条件 | `type="array"; minItems=3; maxItems=20; uniqueItems=true` |
| `deliveries[].classifications` | 否/条件 | `type="array"; maxItems=5` |
| `deliveries[].classifications[].field` | 是 | `enum=["expectedOutput","metadata"]` |
| `deliveries[].classifications[].basis` | 否/条件 | `enum=["background","user"]` |
| `deliveries[].classifications[].definitions` | 否/条件 | `type="array"; maxItems=100` |
| `deliveries[].classifications[].definitions[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `deliveries[].classifications[].definitions[].text` | 否/条件 | `type="string"; minLength=1; maxLength=2000` |
| `deliveries[].classifications[].definitions[].reference` | 否/条件 | `type="string"; minLength=1; maxLength=100` |
| `deliveries[].classifications[].definitions[].basis` | 否/条件 | `enum=["background","user"]` |
| `deliveries[].classifications[].clear` | 否/条件 | `type="boolean"` |
| `deliveries[].classifications[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `deliveries[].classifications[].allowedValues` | 否/条件 | `type="array"; maxItems=100` |
| `deliveries[].classifications[].requiredValues` | 否/条件 | `type="array"; maxItems=100` |
| `deliveries[].classifications[].quotas` | 否/条件 | `type="array"; maxItems=100` |
| `deliveries[].classifications[].quotas[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `deliveries[].classifications[].quotas[].count` | 是 | `type="integer"; minimum=0; maximum=10000` |
| `deliveries[].remove` | 否/条件 | `type="boolean"` |
| `deliveries[].question` | 否/条件 | `type=["string","null"]; maxLength=500` |
| `removeRequirements` | 否/条件 | `type="array"; maxItems=20` |
| `title` | 否/条件 | `type="string"; minLength=1; maxLength=40` |
| `executionMode` | 否/条件 | `enum=["plan","execute"]` |
| `steps` | 否/条件 | `type="array"; minItems=1; maxItems=40` |
| `steps[]<oneOf:0>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:0>.action` | 是 | `enum=["query_project"]` |
| `steps[]<oneOf:0>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:0>.input.kind` | 否/条件 | `enum=["project","files","testSets","versions","drafts"]` |
| `steps[]<oneOf:0>.input.search` | 否/条件 | `type="string"; maxLength=100` |
| `steps[]<oneOf:0>.input.offset` | 否/条件 | `type="integer"; minimum=0` |
| `steps[]<oneOf:0>.input.testSetId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:0>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:1>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:1>.action` | 是 | `enum=["read_records"]` |
| `steps[]<oneOf:1>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:1>.input.source` | 否/条件 | `type="object"; required=["kind"]; additionalProperties=false` |
| `steps[]<oneOf:1>.input.source.kind` | 是 | `enum=["assets","draft","version"]` |
| `steps[]<oneOf:1>.input.source.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `steps[]<oneOf:1>.input.source.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:1>.input.offset` | 否/条件 | `type="integer"; minimum=0` |
| `steps[]<oneOf:1>.input.limit` | 否/条件 | `type="integer"; minimum=1; maximum=20` |
| `steps[]<oneOf:1>.input.groupBy` | 否/条件 | `enum=["expectedOutput"]` |
| `steps[]<oneOf:1>.input.selection` | 否/条件 | `type="object"; additionalProperties=false; required=["method"]` |
| `steps[]<oneOf:1>.input.selection.method` | 是 | `enum=["all","random"]` |
| `steps[]<oneOf:1>.input.selection.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:1>.input.selection.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:1>.input.selection.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:1>.input.selection.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:1>.input.selection.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:1>.input.selection.mode` | 否/条件 | `enum=["count","percent"]` |
| `steps[]<oneOf:1>.input.selection.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `steps[]<oneOf:1>.input.selection.seed` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:1>.input.reselect` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:1>.input.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:1>.input.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:1>.input.conditions[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:1>.input.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:1>.input.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:1>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:2>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:2>.action` | 是 | `enum=["read_background"]` |
| `steps[]<oneOf:2>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:2>.input.documentId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:2>.input.query` | 否/条件 | `type="string"; minLength=1; maxLength=200` |
| `steps[]<oneOf:2>.input.from` | 否/条件 | `type="integer"; minimum=1` |
| `steps[]<oneOf:2>.input.limit` | 否/条件 | `type="integer"; minimum=1; maximum=3` |
| `steps[]<oneOf:2>.input.useForProcessing` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:2>.input.replaceEvidence` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:2>.input.directoryFrom` | 否/条件 | `type="integer"; minimum=1` |
| `steps[]<oneOf:2>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:3>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:3>.action` | 是 | `enum=["create_draft"]` |
| `steps[]<oneOf:3>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:3>.input.name` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:3>.input.purpose` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:3>.input.testSetId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:3>.input.parentVersionId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:3>.input.createAnother` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:3>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:4>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:4>.action` | 是 | `enum=["preview_selection"]` |
| `steps[]<oneOf:4>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:4>.input.draftId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:4>.input.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `steps[]<oneOf:4>.input.method` | 否/条件 | `enum=["all","random"]` |
| `steps[]<oneOf:4>.input.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:4>.input.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:4>.input.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:4>.input.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:4>.input.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:4>.input.mode` | 否/条件 | `enum=["count","percent"]` |
| `steps[]<oneOf:4>.input.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `steps[]<oneOf:4>.input.seed` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:4>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:5>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:5>.action` | 是 | `enum=["submit_processing"]` |
| `steps[]<oneOf:5>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:5>.input.source` | 否/条件 | `type="object"; required=["kind"]; additionalProperties=false` |
| `steps[]<oneOf:5>.input.source.kind` | 是 | `enum=["assets","draft","version"]` |
| `steps[]<oneOf:5>.input.source.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `steps[]<oneOf:5>.input.source.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:5>.input.recordIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `steps[]<oneOf:5>.input.allRecords` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:5>.input.selection` | 否/条件 | `分支对象；完整条件见 JSON` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.method` | 是 | `enum=["all","random"]` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.mode` | 否/条件 | `enum=["count","percent"]` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `steps[]<oneOf:5>.input.selection<anyOf:0>.seed` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:5>.input.reselect` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:5>.input.operation` | 否/条件 | `enum=["clean","rewrite","augment"]` |
| `steps[]<oneOf:5>.input.instructions` | 否/条件 | `type="string"; maxLength=8000` |
| `steps[]<oneOf:5>.input.allowedFields` | 否/条件 | `type="array"; minItems=1; maxItems=3; uniqueItems=true` |
| `steps[]<oneOf:5>.input.metadataKeys` | 否/条件 | `type="array"; minItems=1; maxItems=100; uniqueItems=true` |
| `steps[]<oneOf:5>.input.outputCount` | 否/条件 | `type="integer"; minimum=1; maximum=10000` |
| `steps[]<oneOf:5>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:6>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:6>.action` | 是 | `enum=["generate_candidates"]` |
| `steps[]<oneOf:6>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:6>.input.name` | 否/条件 | `type="string"; minLength=1; maxLength=200` |
| `steps[]<oneOf:6>.input.purpose` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:6>.input.instructions` | 否/条件 | `type="string"; minLength=1; maxLength=8000` |
| `steps[]<oneOf:6>.input.outputCount` | 否/条件 | `type="integer"; minimum=1; maximum=10000` |
| `steps[]<oneOf:6>.input.scenarios` | 否/条件 | `type="array"; minItems=1; maxItems=20; uniqueItems=true` |
| `steps[]<oneOf:6>.input.metadataKeys` | 否/条件 | `type="array"; minItems=1; maxItems=100; uniqueItems=true` |
| `steps[]<oneOf:6>.input.classifications` | 否/条件 | `type="array"; maxItems=5` |
| `steps[]<oneOf:6>.input.classifications[].field` | 是 | `enum=["expectedOutput","metadata"]` |
| `steps[]<oneOf:6>.input.classifications[].basis` | 否/条件 | `enum=["background","user"]` |
| `steps[]<oneOf:6>.input.classifications[].definitions` | 否/条件 | `type="array"; maxItems=100` |
| `steps[]<oneOf:6>.input.classifications[].definitions[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `steps[]<oneOf:6>.input.classifications[].definitions[].text` | 否/条件 | `type="string"; minLength=1; maxLength=2000` |
| `steps[]<oneOf:6>.input.classifications[].definitions[].reference` | 否/条件 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:6>.input.classifications[].definitions[].basis` | 否/条件 | `enum=["background","user"]` |
| `steps[]<oneOf:6>.input.classifications[].clear` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:6>.input.classifications[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:6>.input.classifications[].allowedValues` | 否/条件 | `type="array"; maxItems=100` |
| `steps[]<oneOf:6>.input.classifications[].requiredValues` | 否/条件 | `type="array"; maxItems=100` |
| `steps[]<oneOf:6>.input.classifications[].quotas` | 否/条件 | `type="array"; maxItems=100` |
| `steps[]<oneOf:6>.input.classifications[].quotas[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `steps[]<oneOf:6>.input.classifications[].quotas[].count` | 是 | `type="integer"; minimum=0; maximum=10000` |
| `steps[]<oneOf:6>.input.requirements` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:6>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:7>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:7>.action` | 是 | `enum=["select_candidates"]` |
| `steps[]<oneOf:7>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:7>.input.runId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:7>.input.selection` | 否/条件 | `type="object"; additionalProperties=false; required=["method"]` |
| `steps[]<oneOf:7>.input.selection.method` | 是 | `enum=["all","random"]` |
| `steps[]<oneOf:7>.input.selection.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `steps[]<oneOf:7>.input.selection.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:7>.input.selection.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:7>.input.selection.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:7>.input.selection.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:7>.input.selection.mode` | 否/条件 | `enum=["count","percent"]` |
| `steps[]<oneOf:7>.input.selection.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `steps[]<oneOf:7>.input.selection.seed` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:7>.input.seed` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:7>.input.groups` | 否/条件 | `type="array"; minItems=1; maxItems=100` |
| `steps[]<oneOf:7>.input.groups[].count` | 是 | `type="integer"; minimum=1; maximum=10000` |
| `steps[]<oneOf:7>.input.groups[].conditions` | 是 | `type="array"; maxItems=20` |
| `steps[]<oneOf:7>.input.groups[].conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:7>.input.groups[].conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:7>.input.groups[].conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `steps[]<oneOf:7>.input.groups[].conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:7>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:8>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:8>.action` | 是 | `enum=["refine_candidates"]` |
| `steps[]<oneOf:8>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:8>.input.runId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:8>.input.resultIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `steps[]<oneOf:8>.input.allSelected` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:8>.input.allResults` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:8>.input.where` | 否/条件 | `type="object"; required=["field","operator","value"]; additionalProperties=false` |
| `steps[]<oneOf:8>.input.where.field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `steps[]<oneOf:8>.input.where.key` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:8>.input.where.operator` | 是 | `enum=["equals","contains"]` |
| `steps[]<oneOf:8>.input.where.value` | 是 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:8>.input.instructions` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:8>.input.allowedFields` | 否/条件 | `type="array"; minItems=1; maxItems=3; uniqueItems=true` |
| `steps[]<oneOf:8>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:9>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:9>.action` | 是 | `enum=["retry_processing"]` |
| `steps[]<oneOf:9>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:9>.input.runId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:9>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:10>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:10>.action` | 是 | `enum=["read_processing"]` |
| `steps[]<oneOf:10>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:10>.input.runId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:10>.input.offset` | 否/条件 | `type="integer"; minimum=0` |
| `steps[]<oneOf:10>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:11>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:11>.action` | 是 | `enum=["request_selection_apply"]` |
| `steps[]<oneOf:11>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:11>.input.draftId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:11>.input.previewId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:11>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:12>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:12>.action` | 是 | `enum=["request_processing_apply"]` |
| `steps[]<oneOf:12>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:12>.input.runId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:12>.input.resultIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `steps[]<oneOf:12>.input.allValid` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:12>.input.allTask` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:12>.input.allSelected` | 否/条件 | `type="boolean"` |
| `steps[]<oneOf:12>.input.target` | 否/条件 | `type="object"; required=["kind"]; additionalProperties=false` |
| `steps[]<oneOf:12>.input.target.kind` | 是 | `enum=["asset","newDraft","draft"]` |
| `steps[]<oneOf:12>.input.target.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:12>.input.target.name` | 否/条件 | `type="string"; maxLength=200` |
| `steps[]<oneOf:12>.input.target.purpose` | 否/条件 | `type="string"; maxLength=2000` |
| `steps[]<oneOf:12>.scope` | 否/条件 | `enum=["preview","all"]` |
| `steps[]<oneOf:13>.title` | 是 | `type="string"; minLength=1; maxLength=100` |
| `steps[]<oneOf:13>.action` | 是 | `enum=["request_publish"]` |
| `steps[]<oneOf:13>.input` | 否/条件 | `type="object"; additionalProperties=false` |
| `steps[]<oneOf:13>.input.draftId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `steps[]<oneOf:13>.scope` | 否/条件 | `enum=["preview","all"]` |
| `requirements` | 否/条件 | `type="array"; maxItems=20` |
| `targetCount` | 否/条件 | `type=["integer","null"]; minimum=1; maximum=10000` |
| `overallTargetCount` | 否/条件 | `type=["integer","null"]; minimum=1; maximum=10000` |
| `countKind` | 否/条件 | `enum=["new","final"]` |
| `targetDraftId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `allowedLabels` | 否/条件 | `type="array"; maxItems=100` |
| `classifications` | 否/条件 | `type="array"; maxItems=5` |
| `classifications[].field` | 是 | `enum=["expectedOutput","metadata"]` |
| `classifications[].basis` | 否/条件 | `enum=["background","user"]` |
| `classifications[].definitions` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].definitions[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `classifications[].definitions[].text` | 否/条件 | `type="string"; minLength=1; maxLength=2000` |
| `classifications[].definitions[].reference` | 否/条件 | `type="string"; minLength=1; maxLength=100` |
| `classifications[].definitions[].basis` | 否/条件 | `enum=["background","user"]` |
| `classifications[].clear` | 否/条件 | `type="boolean"` |
| `classifications[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `classifications[].allowedValues` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].requiredValues` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].quotas` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].quotas[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `classifications[].quotas[].count` | 是 | `type="integer"; minimum=0; maximum=10000` |
| `target` | 否/条件 | `分支对象；完整条件见 JSON` |
| `target<anyOf:0>.kind` | 是 | `enum=["assets","draft","version"]` |
| `target<anyOf:0>.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `target<anyOf:0>.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `allowedFields` | 否/条件 | `type="array"; maxItems=3; uniqueItems=true` |
| `metadataKeys` | 否/条件 | `type=["array","null"]; maxItems=100; uniqueItems=true` |
| `nextAction` | 否/条件 | `enum=["query_project","read_records","read_background","create_draft","preview_selection","submit_processing","generate_candidates","select_candidates","refine_candidates","retry_processing","read_processing","request_selection_apply","request_processing_apply","request_publish","none"]` |
| `question` | 否/条件 | `type="string"; minLength=1; maxLength=1000` |

## read_background

源码：`src/assistant/agent.ts:3962`。固定执行必填：`documentId`；模型声明必填：`documentId`。

| 字段 | 核对结果与条件 |
| --- | --- |
| `documentId` | 会话内真实文档引用；项目/会话、摘要、提取版本及片段证据核验。 |
| `query` | 可省略，非空短查询；空白字符串Schema可过但服务拒绝，TP06。 |
| `from` | from默认1、limit默认3且至多3；directoryFrom独立默认1；匹配列表游标与原文片段/目录不得混用。 |
| `limit` | from默认1、limit默认3且至多3；directoryFrom独立默认1；匹配列表游标与原文片段/目录不得混用。 |
| `useForProcessing` | query只浏览；执行时默认选用，false明确只浏览；替换仅对实际选用生效，12片段限制和计划失效保留。 |
| `replaceEvidence` | query只浏览；执行时默认选用，false明确只浏览；替换仅对实际选用生效，12片段限制和计划失效保留。 |
| `directoryFrom` | from默认1、limit默认3且至多3；directoryFrom独立默认1；匹配列表游标与原文片段/目录不得混用。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `documentId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `query` | 否/条件 | `type="string"; minLength=1; maxLength=200` |
| `from` | 否/条件 | `type="integer"; minimum=1` |
| `limit` | 否/条件 | `type="integer"; minimum=1; maximum=3` |
| `useForProcessing` | 否/条件 | `type="boolean"` |
| `replaceEvidence` | 否/条件 | `type="boolean"` |
| `directoryFrom` | 否/条件 | `type="integer"; minimum=1` |

## query_project

源码：`src/assistant/agent.ts:4074`。固定执行必填：`kind`；模型声明必填：`kind`。

| 字段 | 核对结果与条件 |
| --- | --- |
| `kind` | project/files/testSets/versions/drafts分支；草稿另检写权限；发现依赖作用域见F06。 |
| `search` | search/offset用于列表，testSetId仅versions使用；其他kind接受但忽略无关字段，TP05。offset默认0/每页20。 |
| `offset` | search/offset用于列表，testSetId仅versions使用；其他kind接受但忽略无关字段，TP05。offset默认0/每页20。 |
| `testSetId` | search/offset用于列表，testSetId仅versions使用；其他kind接受但忽略无关字段，TP05。offset默认0/每页20。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `kind` | 是 | `enum=["project","files","testSets","versions","drafts"]` |
| `search` | 否/条件 | `type="string"; maxLength=100` |
| `offset` | 否/条件 | `type="integer"; minimum=0` |
| `testSetId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |

## read_records

源码：`src/assistant/agent.ts:4148`。固定执行必填：`source`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `source` | sourceSchema同源绑定；分页读取受权，固定选择仅在可执行意图时保存。 |
| `offset` | offset默认0、limit默认10最多20；groupBy仅expectedOutput；匹配统计不是本页统计。 |
| `limit` | offset默认0、limit默认10最多20；groupBy仅expectedOutput；匹配统计不是本页统计。 |
| `groupBy` | offset默认0、limit默认10最多20；groupBy仅expectedOutput；匹配统计不是本页统计。 |
| `selection` | selection优先导致顶层conditions被忽略；selection缺conditions/mode不走提交入口补齐；reselect只随选择生效；TP01/02。条件比较见TP04。 |
| `reselect` | selection优先导致顶层conditions被忽略；selection缺conditions/mode不走提交入口补齐；reselect只随选择生效；TP01/02。条件比较见TP04。 |
| `conditions` | selection优先导致顶层conditions被忽略；selection缺conditions/mode不走提交入口补齐；reselect只随选择生效；TP01/02。条件比较见TP04。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `source` | 是 | `type="object"; required=["kind"]; additionalProperties=false` |
| `source.kind` | 是 | `enum=["assets","draft","version"]` |
| `source.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `source.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `offset` | 否/条件 | `type="integer"; minimum=0` |
| `limit` | 否/条件 | `type="integer"; minimum=1; maximum=20` |
| `groupBy` | 否/条件 | `enum=["expectedOutput"]` |
| `selection` | 否/条件 | `type="object"; additionalProperties=false; required=["method"]` |
| `selection.method` | 是 | `enum=["all","random"]` |
| `selection.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `selection.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `selection.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `selection.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `selection.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `selection.mode` | 否/条件 | `enum=["count","percent"]` |
| `selection.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `selection.seed` | 否/条件 | `type="string"; maxLength=200` |
| `reselect` | 否/条件 | `type="boolean"` |
| `conditions` | 否/条件 | `type="array"; maxItems=20` |
| `conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `conditions[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |

## create_draft

源码：`src/assistant/agent.ts:4295`。固定执行必填：``；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `name` | 全新草稿可省略；与testSetId互斥由业务层检查。会话同名复用不应用新purpose，需明确复用语义，TP05。 |
| `purpose` | 全新草稿可省略；与testSetId互斥由业务层检查。会话同名复用不应用新purpose，需明确复用语义，TP05。 |
| `testSetId` | 继承版本必须成对，且不能混name/purpose；Schema未表达；复用分支可能提前绕过此组合检查，TP05。 |
| `parentVersionId` | 继承版本必须成对，且不能混name/purpose；Schema未表达；复用分支可能提前绕过此组合检查，TP05。 |
| `createAnother` | true强制新建，其他默认会话同名复用；不授予发布或覆盖权限。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `name` | 否/条件 | `type="string"; maxLength=200` |
| `purpose` | 否/条件 | `type="string"; maxLength=2000` |
| `testSetId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `parentVersionId` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `createAnother` | 否/条件 | `type="boolean"` |

## preview_selection

源码：`src/assistant/agent.ts:4352`。固定执行必填：`draftId,assetIds,method,conditions`；模型声明必填：`assetIds,method,conditions`。

| 字段 | 核对结果与条件 |
| --- | --- |
| `draftId` | 草稿＋最多5个原始文件，权限和可编辑性再校验；预览与草稿成对。 |
| `assetIds` | 草稿＋最多5个原始文件，权限和可编辑性再校验；预览与草稿成对。 |
| `method` | 扁平选择参数；conditions固定必填，method/mode/数值条件未与selectionSchema统一；预览服务再校验，TP01。 |
| `conditions` | 扁平选择参数；conditions固定必填，method/mode/数值条件未与selectionSchema统一；预览服务再校验，TP01。 |
| `mode` | 扁平选择参数；conditions固定必填，method/mode/数值条件未与selectionSchema统一；预览服务再校验，TP01。 |
| `value` | 扁平选择参数；conditions固定必填，method/mode/数值条件未与selectionSchema统一；预览服务再校验，TP01。 |
| `seed` | 扁平选择参数；conditions固定必填，method/mode/数值条件未与selectionSchema统一；预览服务再校验，TP01。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `draftId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `assetIds` | 是 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `method` | 是 | `enum=["all","random"]` |
| `conditions` | 是 | `type="array"; maxItems=20` |
| `conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `mode` | 否/条件 | `enum=["count","percent"]` |
| `value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `seed` | 否/条件 | `type="string"; maxLength=200` |

## generate_candidates

源码：`src/assistant/agent.ts:4433`。固定执行必填：`name,instructions,outputCount`；模型声明必填：`name,outputCount`。

| 字段 | 核对结果与条件 |
| --- | --- |
| `name` | 服务端幂等建立目标草稿；已有部分提交先对账，F05。 |
| `purpose` | 服务端幂等建立目标草稿；已有部分提交先对账，F05。 |
| `instructions` | 生成说明非空至多8000，数量1–10000；后台无原始输入，outputCount合法且必需，TP06/07。 |
| `outputCount` | 生成说明非空至多8000，数量1–10000；后台无原始输入，outputCount合法且必需，TP06/07。 |
| `scenarios` | 直接工具至少1，deliveries至少3；文案称用户场景数量优先，当前存在冲突，TP06。 |
| `metadataKeys` | 按当前真实背景和交付合并；字段保护及Metadata限制在freezeBackground重检；不把定义写成执行指令。 |
| `classifications` | 按当前真实背景和交付合并；字段保护及Metadata限制在freezeBackground重检；不把定义写成执行指令。 |
| `requirements` | 按当前真实背景和交付合并；字段保护及Metadata限制在freezeBackground重检；不把定义写成执行指令。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `name` | 是 | `type="string"; minLength=1; maxLength=200` |
| `purpose` | 否/条件 | `type="string"; maxLength=2000` |
| `instructions` | 是 | `type="string"; minLength=1; maxLength=8000` |
| `outputCount` | 是 | `type="integer"; minimum=1; maximum=10000` |
| `scenarios` | 否/条件 | `type="array"; minItems=1; maxItems=20; uniqueItems=true` |
| `metadataKeys` | 否/条件 | `type="array"; minItems=1; maxItems=100; uniqueItems=true` |
| `classifications` | 否/条件 | `type="array"; maxItems=5` |
| `classifications[].field` | 是 | `enum=["expectedOutput","metadata"]` |
| `classifications[].basis` | 否/条件 | `enum=["background","user"]` |
| `classifications[].definitions` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].definitions[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `classifications[].definitions[].text` | 否/条件 | `type="string"; minLength=1; maxLength=2000` |
| `classifications[].definitions[].reference` | 否/条件 | `type="string"; minLength=1; maxLength=100` |
| `classifications[].definitions[].basis` | 否/条件 | `enum=["background","user"]` |
| `classifications[].clear` | 否/条件 | `type="boolean"` |
| `classifications[].key` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `classifications[].allowedValues` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].requiredValues` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].quotas` | 否/条件 | `type="array"; maxItems=100` |
| `classifications[].quotas[].value` | 是 | `type="string"; minLength=1; maxLength=500` |
| `classifications[].quotas[].count` | 是 | `type="integer"; minimum=0; maximum=10000` |
| `requirements` | 否/条件 | `type="array"; maxItems=20` |

## submit_processing

源码：`src/assistant/agent.ts:4607`。固定执行必填：`source,operation,instructions,allowedFields`；模型声明必填：`operation`。

| 字段 | 核对结果与条件 |
| --- | --- |
| `source` | 真实来源须在当前任务授权内；资产排序，无范围不能默认全量。 |
| `recordIds` | selection与显式ID/全部互斥，但recordIds＋allRecords接受且ID优先；null selection兼容省略；同源固定范围复用；TP01/02。 |
| `allRecords` | selection与显式ID/全部互斥，但recordIds＋allRecords接受且ID优先；null selection兼容省略；同源固定范围复用；TP01/02。 |
| `selection` | selection与显式ID/全部互斥，但recordIds＋allRecords接受且ID优先；null selection兼容省略；同源固定范围复用；TP01/02。 |
| `reselect` | selection与显式ID/全部互斥，但recordIds＋allRecords接受且ID优先；null selection兼容省略；同源固定范围复用；TP01/02。 |
| `operation` | clean可空且无模型规范清理；rewrite/augment要求非空，最终8000上限；要求拼接需完整预检，TP06。 |
| `instructions` | clean可空且无模型规范清理；rewrite/augment要求非空，最终8000上限；要求拼接需完整预检，TP06。 |
| `allowedFields` | 允许字段不能超用户授权；键需trim/大小写去重规则一致；事务freezeBackground复检，TP06。 |
| `metadataKeys` | 允许字段不能超用户授权；键需trim/大小写去重规则一致；事务freezeBackground复检，TP06。 |
| `outputCount` | 仅augment；新增目标可继承，final不能盲用；clean/rewrite数量由输入决定，配置错误需带实际字段路径。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `source` | 是 | `type="object"; required=["kind"]; additionalProperties=false` |
| `source.kind` | 是 | `enum=["assets","draft","version"]` |
| `source.assetIds` | 否/条件 | `type="array"; minItems=1; maxItems=5; uniqueItems=true` |
| `source.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `recordIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `allRecords` | 否/条件 | `type="boolean"` |
| `selection` | 否/条件 | `分支对象；完整条件见 JSON` |
| `selection<anyOf:0>.method` | 是 | `enum=["all","random"]` |
| `selection<anyOf:0>.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `selection<anyOf:0>.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `selection<anyOf:0>.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `selection<anyOf:0>.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `selection<anyOf:0>.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `selection<anyOf:0>.mode` | 否/条件 | `enum=["count","percent"]` |
| `selection<anyOf:0>.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `selection<anyOf:0>.seed` | 否/条件 | `type="string"; maxLength=200` |
| `reselect` | 否/条件 | `type="boolean"` |
| `operation` | 是 | `enum=["clean","rewrite","augment"]` |
| `instructions` | 是 | `type="string"; maxLength=8000` |
| `allowedFields` | 是 | `type="array"; minItems=1; maxItems=3; uniqueItems=true` |
| `metadataKeys` | 否/条件 | `type="array"; minItems=1; maxItems=100; uniqueItems=true` |
| `outputCount` | 否/条件 | `type="integer"; minimum=1; maximum=10000` |

## select_candidates

源码：`src/assistant/agent.ts:4791`。固定执行必填：`runId`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `runId` | 必须属于当前候选任务并已结束，不能把历史运行当当前全部。 |
| `selection` | 恰选一个；groups顺序排除已选结果并报告缺额；条件需完整有效，TP01/04/07。 |
| `seed` | 顶层仅groups派生子种子；selection分支没传入顶层seed、保存seed可与实际不同，TP03。 |
| `groups` | 恰选一个；groups顺序排除已选结果并报告缺额；条件需完整有效，TP01/04/07。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `runId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `selection` | 否/条件 | `type="object"; additionalProperties=false; required=["method"]` |
| `selection.method` | 是 | `enum=["all","random"]` |
| `selection.conditions` | 否/条件 | `type="array"; maxItems=20` |
| `selection.conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `selection.conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `selection.conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `selection.conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |
| `selection.mode` | 否/条件 | `enum=["count","percent"]` |
| `selection.value` | 否/条件 | `type="number"; exclusiveMinimum=0; maximum=10000` |
| `selection.seed` | 否/条件 | `type="string"; maxLength=200` |
| `seed` | 否/条件 | `type="string"; maxLength=200` |
| `groups` | 否/条件 | `type="array"; minItems=1; maxItems=100` |
| `groups[].count` | 是 | `type="integer"; minimum=1; maximum=10000` |
| `groups[].conditions` | 是 | `type="array"; maxItems=20` |
| `groups[].conditions[].field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `groups[].conditions[].key` | 否/条件 | `type="string"; maxLength=2000` |
| `groups[].conditions[].operator` | 是 | `enum=["contains","equals","empty","filled"]` |
| `groups[].conditions[].value` | 否/条件 | `type="string"; maxLength=2000` |

## refine_candidates

源码：`src/assistant/agent.ts:4903`。固定执行必填：`runId,instructions,allowedFields`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `runId` | 可据当前勾选/同交付回执补齐，校验当前候选及替换历史，禁止操作已采用成果。 |
| `resultIds` | 四种范围互斥；UI绑定可能追加allSelected与显式allResults冲突；where与其他选择器语义不同，TP02/04。 |
| `allSelected` | 四种范围互斥；UI绑定可能追加allSelected与显式allResults冲突；where与其他选择器语义不同，TP02/04。 |
| `allResults` | 四种范围互斥；UI绑定可能追加allSelected与显式allResults冲突；where与其他选择器语义不同，TP02/04。 |
| `where` | 四种范围互斥；UI绑定可能追加allSelected与显式allResults冲突；where与其他选择器语义不同，TP02/04。 |
| `instructions` | 说明上限2000（处理服务8000）；显式授权字段优先；Metadata键由背景冻结保护继承，不因工具没metadataKeys而判定绕过。 |
| `allowedFields` | 说明上限2000（处理服务8000）；显式授权字段优先；Metadata键由背景冻结保护继承，不因工具没metadataKeys而判定绕过。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `runId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `resultIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `allSelected` | 否/条件 | `type="boolean"` |
| `allResults` | 否/条件 | `type="boolean"` |
| `where` | 否/条件 | `type="object"; required=["field","operator","value"]; additionalProperties=false` |
| `where.field` | 是 | `enum=["question","expectedOutput","metadata"]` |
| `where.key` | 否/条件 | `type="string"; maxLength=2000` |
| `where.operator` | 是 | `enum=["equals","contains"]` |
| `where.value` | 是 | `type="string"; maxLength=2000` |
| `instructions` | 是 | `type="string"; maxLength=2000` |
| `allowedFields` | 是 | `type="array"; minItems=1; maxItems=3; uniqueItems=true` |

## retry_processing

源码：`src/assistant/agent.ts:5108`。固定执行必填：`runId`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `runId` | 真实run、现有恢复能力和原预算；已结束只对账；不得重新提交成功批次，F08–F10。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `runId` | 是 | `type="string"; minLength=1; maxLength=250` |

## read_processing

源码：`src/assistant/agent.ts:5164`。固定执行必填：`runId`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `runId` | 当前事件限定run；汇总任务实际成果，offset只分页10条预览；读取会投影review/stage，不是纯无状态函数，F06/F09及OPT48/49限制。 |
| `offset` | 当前事件限定run；汇总任务实际成果，offset只分页10条预览；读取会投影review/stage，不是纯无状态函数，F06/F09及OPT48/49限制。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `runId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `offset` | 否/条件 | `type="integer"; minimum=0` |

## request_selection_apply

源码：`src/assistant/agent.ts:5267`。固定执行必填：`draftId,previewId`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `draftId` | 真实匹配对；服务端固定selectedIds和当前revision成确认卡，点击时再验；禁止独立取两个不相干最近引用。 |
| `previewId` | 真实匹配对；服务端固定selectedIds和当前revision成确认卡，点击时再验；禁止独立取两个不相干最近引用。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `draftId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `previewId` | 是 | `type="string"; minLength=1; maxLength=250` |

## request_processing_apply

源码：`src/assistant/agent.ts:5313`。固定执行必填：`runId,target`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `runId` | 候选属于当前任务，全部相关执行已结束；目标及选定记录固定入确认。 |
| `resultIds` | 显式采用范围；UI勾选可覆写false/全部；部分混用被忽略而非统一拒绝；allValid默认提升allTask有旧兼容，TP02须保留版本边界。 |
| `allValid` | 显式采用范围；UI勾选可覆写false/全部；部分混用被忽略而非统一拒绝；allValid默认提升allTask有旧兼容，TP02须保留版本边界。 |
| `allTask` | 显式采用范围；UI勾选可覆写false/全部；部分混用被忽略而非统一拒绝；allValid默认提升allTask有旧兼容，TP02须保留版本边界。 |
| `allSelected` | 显式采用范围；UI勾选可覆写false/全部；部分混用被忽略而非统一拒绝；allValid默认提升allTask有旧兼容，TP02须保留版本边界。 |
| `target` | kind asset/newDraft/draft；draft需id，newDraft需非空name；字段按kind允许集合未在Schema完整表达，TP05。revision由服务端补，不来自模型。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `runId` | 是 | `type="string"; minLength=1; maxLength=250` |
| `resultIds` | 否/条件 | `type="array"; minItems=1; maxItems=10000; uniqueItems=true` |
| `allValid` | 否/条件 | `type="boolean"` |
| `allTask` | 否/条件 | `type="boolean"` |
| `allSelected` | 否/条件 | `type="boolean"` |
| `target` | 是 | `type="object"; required=["kind"]; additionalProperties=false` |
| `target.kind` | 是 | `enum=["asset","newDraft","draft"]` |
| `target.id` | 否/条件 | `type="string"; minLength=1; maxLength=250` |
| `target.name` | 否/条件 | `type="string"; maxLength=200` |
| `target.purpose` | 否/条件 | `type="string"; maxLength=2000` |

## request_publish

源码：`src/assistant/agent.ts:5582`。固定执行必填：`draftId`；模型声明必填：``。

| 字段 | 核对结果与条件 |
| --- | --- |
| `draftId` | 从当前/同交付回执补齐，读取可发布草稿真实修订；核对通过只生成确认卡，确认后才发布。 |

### 嵌套字段及约束

| 路径 | 该层必填 | 约束摘要 |
| --- | --- | --- |
| `draftId` | 是 | `type="string"; minLength=1; maxLength=250` |
