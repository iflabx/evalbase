# OPT-50 续接交互：开发、定向验证与4217有限验收

日期：2026-10-23。服务器工作树 /home/bistu/EvalBase/.worktrees/agent-data-processing，分支 codex/assistant-optimization。实现代码 **be2b8b1ff7e1edbddce2cfe95617dd10908fd5ba**，基线eabfc32。

## 当前结论

本票页面和必要身份绑定已实现，58项不同定向用例通过；4217已更新同一固定代码，旧数据与旧预算保持。**整票保持in-progress / Validation partial-pass / Owner pending，不能标完成或CU通过。** CU7初始2+2和重复核对成功，3+2阶段被本次临时验收门禁误拦，不能当作项目/模型失败；CU10则暴露真实查询参数纠错与来源澄清未闭合。两项按约定停止并关闭，不重开、不加额、不重跑历史部分。

## 实现

- 工作卡、提交错误和按钮消费服务端feedback、taskId、budget及offer；不在前端重算额度或按旧错误码猜当前任务状态。旧消息迟到不影响当前成功和输入。
- 继续/修复额度复用原Dialog与按钮；展示实际目标、待保存请求和持久未完成步骤，明确purpose、单段上限及已用量。只有确认才提交offerId/当前修订/用途/accept，不能填任意数字；失败、到期、并发冲突重新读取能力，保留输入。
- 历史任务按需只读读取；原确认卡归原任务。选择恢复后仅填入可见请求，用户发送才恢复。现有消息入口增加受修订/会话/权限/幂等保护的restoreTaskId选择器，精确恢复同名历史任务；禁止混入context/candidates/operation。没有新工具、框架或执行权限。
- 首次页面水合不误清待重试幂等键；真正同会话任务切换才清任务绑定。长弹层限制视口高度，正文独立滚动，按钮区可键盘操作。frontend-v1 donor未改。

服务端continuation只展示实际失败请求及存储步骤，SQL绑定当前session/task；不根据聊天措辞重新猜范围或额度。采用/发布固定确认边界保持。

## 定向验证

| 验证 | 实际结果 |
| --- | --- |
| [scope-final](opt50-development-20261023/scope-final.json)：公开预算/状态14、反馈24、工作区6 | 44通过、0失败 |
| [restore-green](opt50-development-20261023/restore-green.json)：真实HTTP/数据库同名任务精确恢复 | 1通过；未知目标404、缺修订/混参数422、旧修订409、同键回放只一次 |
| [ui-final](opt50-development-20261023/ui-final.json)：控后端浏览器页面 | 13通过、0失败/跳过；38秒内完成 |
| 后端/前端TypeScript，受影响文件ESLint及差异检查 | 通过；前端原effect的一项依赖warning未扩大修复 |
| 固定git archive构建及镜像代码标签 | 通过；依赖/锁文件/Dockerfile未改，复用既有固定基础镜像 |

13项页面覆盖显式用途及额度确认、双击/两标签冲突、过期、409保留输入、历史确认禁用、迟到旧回合、已完成不被旧错盖、跨3段轮询、初始水合幂等、精确恢复以及480px/长内容键盘。控后端不访问真实模型/验收库。45项后端/单元使用专属UUID库、本地脚本模型和隔离测试桶。

原始红灯及过程失败保留：scope-red暴露真实待保存请求缺投影；restore-red暴露入口不识别选择器；ui-baseline-red暴露缺额度/修复入口及旧确认未禁用。水合回归的初版夹具错用localStorage，纠正为sessionStorage后通过；其基线再测未复现红灯，不能宣称所有新增断言都已证明旧版失败。Vite共享cache权限、漏project-access模拟、presence误计POST、容器runner挂起、主机字体/动态库缺失均为基础设施或夹具问题，未计为业务失败。后改用独立cache及目录内解包字体/依赖，不改系统包或重启Docker守护进程。

Standards/Spec分开审阅。水合误清键、长Dialog遮按钮及同名恢复不精确三项已补修；最终仅窄复核变更，均无剩余发现。独立代理只审代码，测试由主代理运行，不代签真实CU或Owner验收。

## 全链路与工具覆盖

[统一索引](opt50-development-20261023/coverage-index.md)关联F01～F12、TP01～TP08、15工具/90顶层字段及原399条复用路径。按实际声明、直接/计划/纠错/恢复/确认入口逐项追溯，正负例复用46～49公共流程族；没有把字段数量写成测试通过数。原177/247/170/170各自证据有重叠，不相加，也未重跑真实已完成验收。

由于CU10实际纠错/澄清链失败，R50-5与R50-8/9整体验收不能关闭；静态接线和受控正确结果不足以证明普通开放模型完整业务终点。来源/容量/范围等其他组合仅按已列控制夹具负责，不声称任意模型零错误。

## 4217部署与保护

- 只更新web、model-worker为evalbase-agent-checkpoint:be2b8b1ff7e1；worker仍94177609b4eb，postgres/minio及worker容器身份、卷/网络保持。health、ready及实际JS资产200，代码标签一致。
- 切换前无活动turn/job，已备份数据库与旧env（私有0600，不提交）。18类业务表按旧列逐行指纹保护，兼容新增task_id列，不清空/迁移旧任务额度。部署后旧行逐值相等，验收后原行全部仍在；22份旧预算文件SHA不变。
- 原无关dirty semantic-results.json SHA256仍c99545cc5a5af148cbc194935cf8973fff6260829435b9f717903f1db2f52a0c；未触碰、回滚或纳入提交。
- 本机4217环回SSH隧道已恢复；没有公开暴露端口。使用已有验收账号，无新账号/密码变更。

## 真实Computer Use：仅一个新合成项目、两个独立新会话

模型设置revision 2、qwen-new，沿原endpoint/key；不改变模型配置。项目project_3a3ebb3a84bb4c88a31cba295295d7c5。材料/普通提示和执行前限额见[plan](opt50-development-20261023/campaign/plan.json)。所有上传、提示与页面动作由侧栏浏览器实际完成；SQL只读核对，不补造业务结果。

每项最多24实际外发/240000ms活跃，两项48/480000ms；更紧产品限制保持。只允许各一次普通继续，不靠追加授权、内部参数提示或新会话凑通过。实际外发包括纠错/重试，未返回也计；临时门禁落账后才fetch，正文/等待一并计时，不记录密钥/请求正文。

| 项目 | 实际终点 | 外发/活跃 | 判定 |
| --- | --- | --- | --- |
| CU7 conversation_9ac6df2de942478298b83e0933498d35 | 上传新旧规范；初始2+2保存、新版1～3工作日依据及两类别正确；重复要求真实verified；3+2未保存，一次普通继续409 | 5次；实际HTTP11808ms，任务活跃13140ms；产品账6次含本地门禁拒绝，不清零 | **测试设施失效，未完成** |
| CU10 conversation_1ddb87da7a79440badd72e243164f5b4 | 两份可见JSONL已上传并映射，目标仅2条问题有空白；首次查询失败；普通继续查到drafts/files仍未收束成来源问题，未提交清洗 | 13次；HTTP46786ms，任务活跃49878ms | **真实流程失败** |

总18次外发、活跃63018ms；均未超限。处理运行0、生成0、采用0、新草稿0、发布0。合成原始4条/目标2条内容、映射及原文件hash不变。账本已closed=true，两项均关闭；原旧预算不修改。临时门禁随后从web/model-worker移除，服务恢复原启动参数、同代码健康。

### CU7测试设施错误（不能归因模型）

初版临时门禁用message.operation!=clean阻止所有其他operation，误伤合法规划载荷amend_plan。在模型fetch之前抛异常；业务诊断显示application/internal_error、httpStatus空且4ms，外发账本无该请求，源码plan-request.ts对应operation可确认。初始2+2及核对5次均HTTP200，无模型超时证据。

按约定一次普通“继续保存方案，先不要执行”被409 assistant_retry_unavailable拒绝，输入保留。不能把此恢复拒绝单独当作自然模型失败的证明，因为前置异常由测试门禁制造。保留[初版门禁](opt50-development-20261023/campaign/gate-initial.mjs)、修正后门禁和首错截图。后将禁操作约束收窄到真实processing run，仅用于未开始的CU10；**未重开CU7或重置其预算**。CU7最终3+2刷新仍2+2，真实修改终点需要之后单独授权重验。

![CU7首次失败](opt50-development-20261023/cu7-first-failure.png)

### CU10真实问题及需承接事项

1. 首次query_project参数kind=project同时带offset=0/search=数据，被实际条件合同拒绝assistant_tool_input_invalid；后出现assistant_no_progress，未给出具体文件澄清。不是HTTP失败：所有实际请求返回200。
2. 一次普通继续后查询drafts/files成功，但最终assistant_result_incomplete；没有保存具体来源澄清/范围，无清洗回执。当前任务assistanttask_ce814b0f887141619fa91e5e5ea341d8。
3. 本轮首错、一次恢复以及诊断完整保留在[cu-proof](opt50-development-20261023/cu-proof.json)和[关闭账本](opt50-development-20261023/campaign/budget.json)。最终回合repairRequestsUsed=0；不能称为两次参数纠错成功、自动恢复通过或额度耗尽导致。最终10步上限是有界停止事实，不是业务交付完成。
4. 回到所属机制（OPT47发现/条件合同、OPT46/49纠错与恢复）复核：模型声明与执行分支条件是否一致；合法发现结果能否持久收束为一次具体业务来源问题；拒绝参数后的恢复是否推进真实澄清而非重复控制/解释。补充真实坏参数→普通继续→files返回两份资料→持久澄清的公共回归，不扩大token/循环或靠技术提示补范围。本票不另造一套工作流。

![CU10最终失败](opt50-development-20261023/cu10-final-failure.png)

## 仍未通过与交付边界

- CU7最终3+2以及CU10固定2条→清洗→审核→确认保存均未通过。没有清洗结果，无法签清洗后字段保护和确认回执的真实CU终点；只能复用原受控证据。
- 未调用真实追加授权，追加/并发/修复用途只在可控测试验证；没有烧真实长对话、性能压测、内容质量验证或重跑旧248/400条。
- 当前代码和回归可审阅，真实失败仍在4217可查看。整票不关闭；不合并main、不推送、不打tag。后续更改和新真实验收须沿记录承接，不修改本轮关闭预算或改签历史。
