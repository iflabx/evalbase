# C03 人工辅助后继续验收（2026-10-28）

代码：1e2fb65；隔离预览4240。操控GPT-6.1 Terra high。本轮只验收并只读定位，没有修改业务代码。

## 人工辅助与实际覆盖

用户回复已选择CSV。恢复时上传对话框已关闭，项目中已有1份客服预约.csv、3条已映射记录。至少文件选择由用户完成；映射预览/确认的具体点击未被Terra观察，不能记为本轮自动验证。

Terra核对三条预约/改期/取消记录，真实勾选第1和第2条，交给助手创建新v3会话assistant_f2f4daf057274af2bc2ecdfbcd195f96。界面显示页面已选2条；消息受理事件持久化recordIds精确为asset_e0306d0396134348bb3f215c4825367b:1、:2，无第3条。

登记新活动r05-c03-20261028-C03后，仅发送一条普通提示：建一个叫C03验收资料的原始数据集合，把这份文件移进去，再看看我选中的记录，不要处理或生成数据。未重发。

## 首个失败与定位

消息受理后turn_5b72496b358442609cc93bd564017336停留pending，UI显示用户气泡、停止按钮和空白助手答复；无工具操作和模型请求。

只读定位src/assistant-rebuild/session-host.ts:135：持久派发器SQL仍写死s.runtime_version='deepagents-v2'，新会话版本为deepagents-v3，因此永远不被选取。现有SDK回归通过host.runPending直接运行，遗漏真实后台自动派发路径。不是模型输出、参数纠错、预算耗尽或数据库锁：pg_stat_activity无受阻应用查询，模型请求表为空。

按首次阻断停止原则，Terra点击一次停止，事件previousStatus=pending，回合已paused。没有技术救援提示、后端代执行或代码热修，后续创建/移动/读取记录和背景分类均未覆盖。没有模型输出，所以自动归一、参数纠错和状态纠错均未触发。

## 消耗与数据保护

活动上限16实际模型请求、0处理、0生成、25分钟；实际0模型请求/0处理/0生成，started_at=null，已关闭且不重开。旧预算不重置；第二批74请求共享额度本项消耗0。

0处理任务、0草稿、0执行操作、0确认卡；集合仍仅未整理，没有创建目标集合或移动文件。原件SHA-256前后相同，3条原始记录与映射前后完全相同。16张受保护表既有行逐行比较均无变化。

C03未通过，REBUILD-05保持in-progress/partial-pass，不以受控测试通过代替真实验收。

## 后续最小修复建议（未执行）

后台派发使用FORMAL_RUNTIME_VERSION唯一常量和参数化SQL，清查新建/派发/恢复/旧版只读入口是否还有版本字面量。补正常HTTP消息受理→后台自动dispatch→真实SDK受控模型的回归，不能直接runPending替代；另断言旧v2回合不被新运行时消费、原预算保留。修复验证并更新隔离预览后，重测须另开有上限记录，不能重置本活动。

## 证据

同目录C03-dispatch-failed.json、final-audit.json、material-before.json、material-after.json。截图D:/AgentBench_v2/.scratch/assistant-rebuild/r05-c03-dispatch-paused-20261028.jpg。
