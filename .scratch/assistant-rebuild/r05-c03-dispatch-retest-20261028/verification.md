# C03 后台派发补修与独立复测

代码40e930d；隔离预览4240。电脑操控由GPT-6.1 Terra high执行。旧C03活动及记录保留。

## 修复与定向验证

后台dispatch使用FORMAL_RUNTIME_VERSION参数化筛选；wake和recoverConfirmations预先过滤同一当前运行时，保留事务内版本/权限/租约复核；定时派发失败仅记录错误类型。历史v1/v2继续只读，不重放旧任务。Spec版本说明同步v3。

新增真实HTTP受理→后台定时自动dispatch→真实SDK受控模型回归；未修代码复现pending超时。修复后原测试成功状态断言由completed纠正为数据库turn合同succeeded。最终类型检查及5项定向测试通过。组合回归覆盖执行期间并发派发、当前过期租约恢复、旧pending/paused/waiting/executing确认不变、旧预算哨兵不变。Standards/Spec针对性复审无剩余阻断；未运行全量旧验收。

## Computer Use实际覆盖

复用先前由Owner人工上传/确认的客服预约.csv，不重传原件。Terra从文件页真实重新勾第1/2条，创建独立新会话assistant_d47d96640ab14b7a89d9b02f7a7adecd；活动登记完成后才发送普通提示：建一个叫C03补修资料的原始数据集合，把这份文件移进去，再看看我选中的记录，不要处理或生成数据。

自动完成：create_collection→move_material_file→read_records→最终答复。集合collection_94c701ee2ffe4ba198055861bab3431c；创建/移动各唯一material_receipt。读取source固定原件第1/2条，total=2，回答准确；没有第3条内容。首轮不再pending，无tool_error，无模型纠错；read_records.source有1次无损parameter_normalized，无新增纠错模型请求。

背景MD通过Computer Use原生选择成功，耗时约177秒，界面明确显示预约说明.md。随后普通提示要求按文档说明两条分类及依据，助手实际调用read_attachment，引用第2行预约、第3行改期定义并准确回答。两回合均succeeded，C03资料操作及背景读取组合场景通过（CSV沿用先前人工上传；本轮没有重新观察CSV映射预览/确认，不声称全自动上传链路通过）。

## 预算与保护

首段新活动r05-c03-dispatch-retest-20261028-C03，上限16请求、0处理/生成、25分钟，实际4次后封存。文件选择最终返回后，另登记仅剩余额度r05-c03-dispatch-background-20261028-C03，上限12请求、0处理/生成、20分钟，未改写首段账本或execution累计用量；背景实用2次后关闭。合计6/16模型请求，0处理/生成。无tool_error、无模型纠错；仅首轮1次source无损归一。未重置/重新打开旧活动；计入第二批共享74请求上限。

原件SHA256仍为e62a80210e453983ece74fb7ba1681da0eb23264a8d0b58a8d941d2232f0344c，3条原始记录及映射完全不变；仅依用户要求改变集合归属。16张受保护表全部既有行无变化，旧预算及旧验收数据不变。未合并或推送，未更新4217或正式环境。

证据：C03-material-completed.json、final-audit.json、material-before.json、material-after.json；定向日志r04-verification/r05-dispatch-red.log及r05-dispatch-final.log；部署health/ready确认40e930d、PG/MinIO正常。

## 最终证据

背景读取：C03-background-completed.json、final-background-audit.json；再次审计旧16张表既有行全不变。原活动已关闭4次、后续活动已关闭2次，合计6次。截图D:/AgentBench_v2/.scratch/assistant-rebuild/r05-c03-retest-attachment-20261028.jpg及D:/AgentBench_v2/.scratch/assistant-rebuild/r05-c03-background-result-20261028.jpg。Computer Use文件选择耗时单独记录为操作工具延迟，本次未测定其内部根因。
