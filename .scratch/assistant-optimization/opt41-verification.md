# OPT-41 实施与有界语义验证

日期：2026-10-20。Implementation completed；Owner人工验收pending。合同见[OPT-41](issues/41-content-review-evidence-and-budget.md)。本票小样本通过预先约定门槛，不代表所有分类正确或原400条质量通过。

## 基线、隔离和数据保护

- 分支codex/assistant-optimization；服务器工作区agent-data-processing。基线17a2c51；应用提交依次为12ed805、bfde2ad、e961ea12165a05943ae04058f4f8a1959c2bd1db。
- 留出集及6条生成前固定应用代码e961ea1，之后没有根据留出结果调参或改应用。最后的live.ts改动仅修正测试启动器会话响应字段sessionId、复用启动中断的隔离项目/会话，不改变样例、模型提示、判据或预算。
- 全部新写入在evalbase-agent-test随机隔离数据库；真实小样本库为opt41_956ba65a34cb4d598a0de92b49590d40，桶opt39-isolated-tests。Owner库仅读取既有模型连接，不写入原项目/会话/数据。
- 原八份400条“已保存、内容质量未通过”、248条历史及原额度、失败记录保持。原冻结快照SHA256前后均为440f3aeeec47cdc8121c28de4d408fd265dc2a23e1ceb811888dacc1770f0196；未重新生成、审核或保存原400条。
- 未切换4217，其Web仍为ddb0b64d827a429fd7486528b7c2ac519bca4d15。未合并、推送或正式部署。临时4220服务和标签已关闭；新增隔离验证库和预算记录保留，不释放Owner数据资源。

## 最小实现

1. 在现有background快照增加可选contentReviewPolicy:evidence-v1，新审核结构version2；缺省继续按旧v1、旧哈希和预算解释。无全局配方升级、迁表或历史重检。部分refine继承父运行的原策略（包括缺省），避免未选旧记录的证据被新标记误作失效。
2. 新审核按冻结定义、要求、已验证背景和当前问题独立判断。去掉生成场景/配额暗示；对待分类标签及对应原值遮蔽，模型返回独立assessedValues，服务器再比较真实标签。明确不符优先于其他规则未知，未知用存疑。outside用独立布尔值，避免和正常业务字符串冲突。
3. 各检查保留结论、简短理由、问题原句、适用输出/原文及文档引用；questionQuote含义明确，兼容quote仍必须定位。引用仅投影documentId/fragmentIndex/quote。未知/伪造/缺少必要证据不能判符合；有真实引文也不自动证明语义正确。
4. 区分原事实保留、新事实断言、假设和无断言。改写要求可定位当前原文；新断言缺支持保留存疑。跨批仅投影有界问题样例（至多20条、原40KB输入限制内），明确非全量语义去重；精确同题碰撞复用OPT-40。
5. 已有生成产物且只余一次原调用时，优先初检，生成/修复/复检继续共享原次数和期限。修复先作为建议，只有授权字段校验且一次复检符合后才换入当前结果；无额度、拒绝、复检不符/存疑或未知响应保留原候选。阶段、原因码、短业务说明持久化，重领不重复调用同一阶段。
6. 前端仅沿既有变化详情显示“模型核对”和可展开“查看逐项依据”，沿frontend-v1现有字体、边框、色彩和密度。没有评分面板、审核Agent、第二模型、新表或公开API。

## 验收映射

| 验收 | 实际证据 |
| --- | --- |
| R41-1 | 单元测试固定错误标签/答案、全符合但缺证据、分类标签遮蔽及服务器比较；真实开发F5曾误放行，遮蔽后仅定向重试为存疑，旧结果保留。 |
| R41-2 | 单元覆盖原句/文档定位、伪造/未知/跨对象引用、漏项、额外字段投影；隔离公开接口覆盖解析/未知响应和零额度；未把引用匹配当语义真值。 |
| R41-3 | 单元验证原事实保留与新断言支持；24条包含GB F/G/H边界、法律依据及假设、退款意图和非GB改写。真实结果和未达理想项见下文。 |
| R41-4 | 公开接口的no_recheck_budget、exhausted、invalid_evidence、response_unknown、interrupted；原每批至多3次，重领零新增调用。测试启动器统一12次/10分钟上限、串行预留及独占锁防竞态。 |
| R41-5 | 正常初检发现问题→建议→一次复检通过才接受，身份/受保护字段保持；无复检额度/替换不合法/复检不符均保留原内容。21条分批只选1条，两种公开入口都保留另20条旧结论和内容。 |
| R41-6 | 旧策略哈希及原生legacy夹具回归；partial refine继承策略，旧预算不刷新；Owner快照哈希不变。真实合同资格变更沿OPT-39，本票未迁移旧数据。 |
| R41-7 | 固定24条、开发/留出各12，明确符合8条识别7，明确不符8和依据不足8均无最终符合；全部尝试和误报/存疑/未核对记录在下文及JSON。 |
| R41-8 | Computer Use新会话普通短提示→方案→执行→6条审核→固定确认卡片；候选6、已保存0，未点确认。真实6条无需修复；有界局部修复故障分支由可控响应覆盖。 |

## 自动验证与审阅

Node24；集成环境通过现有opt39/run-tests.py注入测试配置，不打印密钥。

- 单元：processing-content-review最终23通过；assistant-review14、processing-review14通过，合计51个不同用例。后续只重跑受改动影响的用例，不累计重复执行数。
- 集成：processing-review-evidence9通过；processing-runs中OPT31 bounded batch review7通过，以及OPT31 never reviews两种入口2通过。共69个不同自动化用例。
- 命令：npx vitest run tests/unit/processing-content-review.test.ts tests/unit/assistant-review.test.ts tests/unit/processing-review.test.ts；经测试配置包装执行npx vitest run tests/integration/processing-review-evidence.test.ts；processing-runs分别筛选上述两个用例组。
- tsc --noEmit、受影响文件ESLint、正式前端build:formal、git diff --check通过。前端构建后未再改前端；后端最后修改后另过typecheck及定向ESLint。最终文档检查随本记录完成。
- 详细日志位于服务器opt41/目录：unit、blind-boundaries、public-green1、legacy2、review-fixes、final-static、final-lint及exit文件。初始红测及修正记录同目录保留。
- Standards/Spec两轴审阅及窄复核通过。修复发现包括引用额外字段存储、未选旧审核策略继承、预算串行预留、启动器并发写锁/原子落盘、暂存源码完整性校验、outside标记与业务值碰撞、多规则明确不符不能被未知覆盖。无剩余审阅发现。
- 原assistant-tasks整文件基线4通过/18失败仍见[OPT-39记录](opt39-verification.md#失败与边界如实保留)，本轮未扩围重跑或宣称全仓库绿。

## 固定真实小样本

### 样例、模型与统一额度

固定样例及人工判据在[fixture](../../tests/fixtures/opt41-semantic.json)。18条GB F/G/H边界与6条非GB（意图3、改写3），每种真值8条；开发、留出各12条，各含4符合、4不符、4依据不足。样例先于模型结果冻结，未替换失败样例或修改真值。

GB引文来自已有冻结文档的安全短摘录；具体法律样例使用[官方《治安管理处罚法》文本](https://www.miit.gov.cn/zwgk/zcwj/flfg/art/2022/art_04a0f1fb5df244e39688fd5372623a8d.html)核对第25条，仅作为预先固定样例的依据。运行时不联网补证，不宣称法律咨询能力。

模型qwen-new，连接名“测试 Qwen”、修订2；同一现有连接，没有更换模型或添加评审服务。fixture规范化哈希b9dca7effa712c9c7a7589c4244d357009809d97850b1abf2f9b0e63f8f6d175。

统一上限：30条不同样例、12次实际HTTP模型请求、累计600000ms活动时间。实际30条、10次、60712ms（约60.7秒），0越额请求；最后两次额度未使用，不再追加。原运行本身仍受更严的原预算约束。

[原始预算](opt41/semantic-budget.json)、[全部原始结果](opt41/semantic-results.json)、[汇总](opt41/semantic-summary.json)、[有界启动器](opt41/live.ts)保留。模型请求在发送前扣账，串行执行并持久化，独占文件锁防止两个进程同时消费；未知中断按已预留时限结算，不清零。首次浏览器启动因测试脚本读取错误响应字段而失败，未增加模型请求；复用同一隔离项目和会话修正后继续，无新预算。

### 全部审核请求（含失败，不覆盖历史）

| 请求 | 子集 | 应用代码 | 当次结果 |
| --- | --- | --- | --- |
| 1 | development / GB | 12ed805 | F1 pending；F3 nonconforms；F5 pending；G1 pending；G3 nonconforms；G5 nonconforms；H1 pending；H3 nonconforms；H5 nonconforms |
| 2 | development / intent | 12ed805 | I1 conforms；I2 nonconforms；I3 uncertain |
| 3 | development / GB 定向重试 | bfde2ad | F1 conforms；F5 conforms；G1 conforms；H1 conforms |
| 4 | development / GB 定向重试 | e961ea1 | F5 uncertain |
| 5 | holdout / GB | e961ea1 | F2 conforms；F4 nonconforms；F6 nonconforms；G2 conforms；G4 nonconforms；G6 nonconforms；H2 conforms；H4 nonconforms；H6 nonconforms |
| 6 | holdout / rewrite | e961ea1 | R1 pending；R2 nonconforms；R3 pending |

第1次中4条pending源于模型把quote填成标签/输出而非问题原句；明确questionQuote后仅重试这4条。第3次F5错误符合属于实际漏检；遮蔽生成标签、独立分类并比较后，仅重试F5得到存疑。第5/6次是首次留出检查，之后未调参、未重试。开发中已完成样例不因修复被整批重跑；下面按每ID最后一次实际观察汇总，不冒充同一代码重新跑满24条。

### 分组最终观察矩阵

| 子集 | 人工真值 | 模型符合 | 模型不符 | 模型存疑 | 待核对 |
| --- | --- | --- | --- | --- | --- |
| development | conforms | 4 | 0 | 0 | 0 |
| development | nonconforms | 0 | 4 | 0 | 0 |
| development | uncertain | 0 | 2 | 2 | 0 |
| holdout | conforms | 3 | 0 | 0 | 1 |
| holdout | nonconforms | 0 | 4 | 0 | 0 |
| holdout | uncertain | 0 | 3 | 0 | 1 |

- 明确符合：7/8正确，R1待核对（改写类别证据未满足协议）。
- 明确不符：8/8判不符，最终漏放0。
- 依据不足：2/8存疑（F5、I3），5/8判不符（G5、H5、F6、G6、H6），R3待核对。5条过度确定的判定不算正确，虽然没有被放行为符合。
- 总计符合7、不符13、存疑2、待核对2。按票中“不符/依据不足不得符合，正例至少7/8”门槛通过；不是24/24正确，不能承诺其他文档零漏检。留出集保留这些不足，不用进一步调参/重复调用美化结果。

### 6条普通提示生成闭环

已上传固定客服意图规范，限定只询问已有退款的进度、到账时间或查询方法，不申请退款、不取消订单，期望输出退款查询，不编造已承诺日期。

普通提示：**按附件做6条退款查询意图测试题，口语自然、每题独立，先给方案再执行到待确认，不要自动保存。** 随后只发送：**执行方案**。

请求7/8为规划与执行的助手请求，9为生成，10为批量内容核对；自动续步沿已存计划准备确认，没有额外模型调用。运行processing_c2ae6b76710e457c96b05998643255a7，原冻结inputHash保留于JSON。模型6条符合、无修复建议；人工逐条结果如下，期望输出均为退款查询。

| 条目 | 实际问题 | 人工核查 |
| --- | --- | --- |
| 1 | 我昨天刚提交的退货退款申请，现在后台显示处理中，我想确认一下具体走到哪一步了？ | 询问已提交申请的进度，完整自然。 |
| 2 | 上周三申请的退款到现在还没显示完成，我想查一下现在卡在哪个环节，是商家审核还是平台处理？ | 询问既有申请所处环节，未请求发起退款。 |
| 3 | 那个退款的钱大概几天能到我支付宝账户里？我上周就申请了，想知道大概的到账时间范围。 | 询问既有退款预计到账时间，没有声称平台已作承诺。 |
| 4 | 我申请的退款已经显示商家同意了，但还没看到钱，这种情况一般多久能到账？ | 询问同意退款后的到账时间，是假设场景而非承诺断言。 |
| 5 | 我在订单列表里找不到退款进度的入口，请问应该点哪个按钮才能看到具体的退款状态？ | 询问退款状态查询入口，符合查询方法范围。 |
| 6 | 我想查一下之前那笔退款的详细状态，是在客服页面查还是直接在商品订单详情里看？ | 询问既有退款状态的查看位置，未申请退款或取消订单。 |

6条均语义完整、自然，未编造承诺日期；2进度、2到账时间、2查询入口场景，无完全同题碰撞。没有把同一意图下的主题相近声称为全量语义去重。人工复核为开发侧检查，不代替Owner验收。

Computer Use在独立4220会话实际完成：查看背景→发送普通短提示→保存方案→“执行方案”→候选6/待核对0→展开模型逐项依据→确认卡片。交付awaiting_confirmation、真实proposal pending、草稿记录0、savedCount0；没有点“确认采用”、没有发布。

- [已保存方案](opt41/browser-plan.png)
- [6条结果与已保存0](opt41/browser-results.png)
- [逐项原句/文档证据](opt41/browser-evidence.png)
- [390px窄窗口换行](opt41/browser-narrow.png)
- [固定确认准备](opt41/browser-confirmation.png)

页面复用既有对照弹窗和折叠详情；桌面及390px下证据可读、无横向溢出。viewport已恢复，临时标签、服务、隧道关闭；测试记录/额度留存。4217未更新，原400条/248条及OPT-31内容质量未通过保持。
