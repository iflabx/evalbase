# Standards 独立审查

基线/HEAD：`519d94256026e37a2166b0858510a8e931cbf806`；提交列表为空。已复核捕获 diff 及最新同步修复；初审四项与最终增量一项 P1 均已静态关闭，无遗留 P0/P1。

- **已修 P1 权限** — `src/assistant/store.ts:164`：列表原绕过详情边界；现检查 requires_write、来源依赖、返回前权限与 content_revision，阻止降权、回收及删除后的任务正文返回。依据架构 §3、PRD §2。
- **已修 P1 调度** — `src/assistant/tasks.ts:137`：原单个无效会话中断全实例扫描；现隔离领域错误并校验捕获修订，collect/confirm 均传 expectedRevision。依据合同 §2。
- **已修 P1 候选** — `src/processing/execute.ts:220`：原失败丢掉未选候选；现保留产物并重试替换。result_indices 固定身份，读取/allIds/采纳共同使用，旧产物入清理队列。依据合同 §1/§2。
- **已修 P1 停止** — `src/assistant/tasks.ts:278`、`src/assistant/fence.ts:61`：停止与取消、run 与任务关联均同事务，关联变化有界重试。依据合同 §1、ADR0014。

判断性气味：无需要阻塞的独立项；未把启发当作硬规范。

**已修 P1 续跑竞态** — `src/assistant/agent.ts:1100`：补充回复期间 job 完成，原末尾会落 waiting_input 而丢自动核对；现非终态保留 processing，终态直接全量读取并计算 review、持久 awaiting_review。已读取 held_explain 公共 HTTP 回归，确实安排 job 在回复释放前完成并断言 25 条全量核对。依据合同 §1/§2。

最后增量：`src/assistant/agent.ts:1063` 将模型末条控制事件设为 user，事件来源及服务端确认边界未变；`tests/integration/assistant-tasks.test.ts:384` 新增角色与“不构成新的用户授权”断言，原 event 与真实用户回合数断言保留。`agent.ts:310` 标题硬上限 40、提示 15 字内，与简短标题要求相容。未发现新增 P0/P1 或阻塞性气味。

展示增量：`frontend-v3/src/components/project-assistant.tsx:382` 按会话 ID 匹配已加载详情，优先 task.title/title，其他项回退列表标题；避免改名后选择框滞后及跨会话串名。`frontend-v3/e2e/project-assistant.spec.ts:88` 用旧列表名、新详情名断言当前标题，覆盖该缺陷。无新增 P0/P1 或阻塞性气味。

限制：只读代码审查，未 SSH、未运行测试；主执行者报告前端类型、Browser 9/9，以及真实 Qwen 局部调整 1/3 和自动核对正常回复通过，本审查未独立运行验证。仅修改本报告。
