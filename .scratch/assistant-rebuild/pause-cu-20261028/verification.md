# 暂停恢复修复与组合验收

代码：78211a902e04409e7c854bbf96747685291f7305；隔离预览4240；未合并、推送或正式部署。

## 修复与自动验证

暂停时收窄可执行工具；一次有界状态重选并按原turn持久计数；继续排队后确定结束控制回合。保留未完成要求修改的优先级。明确继续授权来自当前真实用户消息，查询/否定/问句不自动恢复；模糊表达可使用继续按钮。

共享session/参数/规则97项通过。execution完整85项通过，最终授权补修影响子集8项通过，合计87个不同execution用例有通过记录（其中2项新增）。类型、文档、diff检查通过，Standards和Spec复审无阻断。12项短语授权内存检查通过。期间11项full失败保留：9端口夹具、1标题计数夹具、1修改优先级真退化，均修正并复验；未修改正确的修改保护断言。

## Computer Use

- 操控模型：GPT-6.1 Terra high，Chrome Computer Use。
- 新会话：assistant_88e8ac34d4bb497e92e2fdbcbb641d96。
- 新活动：pause-20261028-CHAIN；上限20HTTP/9行/25min，实际15HTTP/3行，已关闭；旧预算不重开。
- 普通提示：前5条只规划→改前3条并另存三条自然问法、现在执行→停止→现在做到哪了→继续→确认阶段停止→查询→继续→点击确认保存。
- 后台处理暂停覆盖：仅新session的batch使用只读事务行锁，持锁2831ms，Stop事件previousStatus=waiting后自动rollback。真实模型请求已发出，覆盖后台作业结果提交前暂停，不声称停止上游推理。未改全局模型连接，无业务UPDATE，窗口已释放。
- 第二次Stop发生confirmation阶段；普通继续成功重建确认卡。
- 最终completed；1个processing run、1份3行草稿、1个acceptance，2张确认卡为旧卡失效和新卡确认。
- 草稿刷新后标题三条自然问法；仅原资料第1—3条，expectedOutput标签1—3和Metadata序号/来源保留；第4—6条未纳入。
- 无tool_error、execution_error、state_feedback或模型纠错请求；read_records.source出现1次无损参数归一。自动错误恢复由受控SDK回归覆盖，本次CU未触发错误重选。
- 16张受保护表的既有行逐行比对无变化，含旧数据、旧预算、model_connection。

## 剩余观察

保存回执标题显示处理文件名“改写结果-fdfb05ab.jsonl”，实际草稿名称“三条自然问法”正确，链接正确。属于展示命名观察，不把它隐瞒为无问题，也不影响本次暂停恢复及唯一保存闭环；本轮未扩大为UI修改。

## 证据

同目录CHAIN-plan.json、CHAIN-final.json、gate-released.json、final-audit.json；服务器完整事件及只读快照保留。截图：D:/AgentBench_v2/.scratch/assistant-rebuild/pause-chain-receipt-20261028.jpg。
