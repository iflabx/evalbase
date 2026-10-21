# OPT-43 实施与定向验证

日期：2026-10-22。票据：[OPT-43](issues/43-requirement-amendments-and-repair-contract.md)。

## 1. 固定版本与结论

- 仓库：服务器 EvalBase 的 agent-data-processing worktree；分支 codex/assistant-optimization。
- 开发基线：6d0f0fa8b5141208c9a07ee8816d38474f231a0d。
- 实现提交：56f4acaddbc981c6a3d28ccc6bdae57396d56059。
- Implementation completed，Validation targeted-pass，Owner pending。阶段 A 合同已接入真实 SDK、HTTP 和隔离持久化入口；不表示后续恢复/页面阶段或五项真实模型流程通过。
- 4217 未切换，仍为本轮开始时的应用92492e7。未合并、推送或调用真实模型，未执行旧248/400条验收、重跑已完成部分或重置旧预算。

## 2. 机制与直接消费者

| 共同责任 | 当前实现与全部直接接入点 | 兼容/退出方式 |
| --- | --- | --- |
| 交付局部变更 | delivery-plan的reviseDeliveryGoals、ruleChanges、fitCount；agent的plan_task最终保存与纠错预校验 | 已有deliveryId缺省保留；新建完整校验；单类旧配额派生新数量，多类未分配仅问业务选择。合法完整输入保留 |
| 失败分流与小范围纠错 | tool-repair的classifyToolFailure、repairScope、argumentRepair；agent的SDK repairToolCall、业务错误recordFailure及prepareStep主循环 | 原独立上下文/截断计数退出，统一持久RepairLimits；同一修改合计最多2次额外请求，截断最多1次；本地无损归一不发模型请求 |
| 业务修复保护 | SDK修复后合回原请求；agent预校验与plan_task最终合同共同使用assertDeliveryRepair、完整schema、文档引用和生效要求校验 | 不允许修复删除交付、弱化合法指令、替换完整场景或伪造分类/授权；已有补丁可省略字段回落到保存事实 |
| 保存与未生效修改 | SDK无效提议与业务入口共用noteRequirementProposal；plan_task通过同一次updateTask保存要求、控制事实、确认失效及requirementSave | 失败保留旧有效计划及待修改身份并阻止沿旧目标执行；仅口头确认不算保存。真实保存与业务澄清可并存，执行门禁保留 |
| 未知结果及并发 | 原有turnFence/updateTask守卫；store.recoverAssistantReceipt增补同项目/用户/修订保存回执核对 | 保存响应丢失先恢复真实回执；同键重复不制造新待修改。只读控制回执核对不提升写权限，写工具仍检查write |
| 尝试记录与读取 | diagnostics.appendObservation/turnDiagnostics；agent保存诊断、store会话读取 | 按(turnId,execution_attempt)记录，区分增量/累计；容量100保留首次根因和最新记录。历史缺项未知，旧计数只在既有恢复路径按版本继承 |

未新增公开路由、数据表、框架或调度器；AI SDK、Fastify、PostgreSQL、MinIO和Worker保持现有组合。旧执行合同仍按现有contractVersion选择schema，不因读取而迁移写回。OPT-44负责后续恢复资格与新段累计扣账，OPT-45负责页面反馈和真实流程验收。

SDK截断处理的具体依据是已安装AI SDK的generate-text执行门禁：length响应中的工具调用不被执行。故不可解析参数在agent适配层交回主循环紧凑重提，使用同一纠错身份和额度，避免内部修好后出现缺少tool result的第二个错误；独立argumentRepair默认行为保持兼容。

## 3. 验收映射

| 票据标准 | 实际定向证据 |
| --- | --- |
| R43-1 | 同会话2+2→3+2→2+1，刷新读取、场景/要求/配额/总数及保存回执一致；仅规划零生成 |
| R43-2 | 场景minItems上下文修复、新建完整合同、已有局部变更、不可解析精简重提及旧steps合同 |
| R43-3 | 单项纠错不改另一项；单类配额派生；多类省略规则或复制旧规则均只澄清真实分配 |
| R43-4 | 本地归一零请求；共享2次/截断1次计数；同turn重试无新额度；同一待修改“继续”不能借新turn重置 |
| R43-5 | 失败修改保留且不执行旧方案；停止期间迟到纠错不覆盖；仅规划及受保护字段/未知引用负例 |
| R43-6 | 保存后响应丢失恢复同修订回执且只写一次；口头已保存无真实回执则拒绝标成功；保存事实与真实澄清并存 |
| R43-7 | 首次validator路径、同turn两次attempt、第二次零请求、历史增量/累计及100条裁剪保留首因 |
| R43-8 | viewer查询、权限/授权不升级、旧steps截断恢复、字段与背景引用校验及原确认/回执边界 |

完整场景定义只在[测试计划§5.18](../../docs/test-plan-data-selection-and-assistant.md#518-机制整理验证待实施)维护，不将阶段B/C断言算作本次通过。

## 4. 测试和真实执行记录

共162个不同定向用例通过：90个单元用例、58个既有意图入口接口用例、14个OPT-43接口用例。使用现有真实SDK和Fastify HTTP入口，模型由本地固定响应服务替代；PostgreSQL为每轮随机隔离库，MinIO仅使用测试桶，不写4217验收项目。

日志位于服务器本worktree的.scratch/assistant-optimization/opt43-logs/：

- unit-final.log：7文件共90例，初次89过、1例断言误把错误hint当message；改为真实错误码后，review-unit-final.log中该文件5例全过，90例不同证据齐全。
- intent-regression.log：初次50/58过；修复viewer回执权限、澄清保存事实和SDK截断适配，并按新的共享额度更新旧脚本预期后，intent-final.log中58/58通过。
- review-regressions.log：13项通过，其中两项恶意改弱夹具经审阅发现可能误中旧会话无ID拒绝。已替换为首次新建同输入的正反对照；其余11例保留有效证据。
- constraint-public-final.log：两项改弱拒绝通过；合法追加已成功保存，但断言未考虑既有服务端追加的生成边界说明。修正为核对保留原指令后，constraint-public-complete.log中三个正反例全过，合计14项不同OPT-43接口用例。
- first-integration.log/second-integration.log、semantic.log/complete-contract.log/final-contract.log：保留开发期失败。包括缺控制的夹具、要求列表顺序、未执行步骤重编译身份的过严断言；已改为校验真实控制、要求集合、交付身份/输入和状态，不将过程失败删为通过。
- truncated-cause.log/truncated-step.log：隔离固定响应下定位SDK length禁止执行及缺tool result；诊断临时打印已移除，未写入交付代码。

受影响文件Prettier、npm run typecheck、服务端tsc编译、定向eslint及git diff --check均通过。没有前端业务改动，不重复构建前端；文档链接、表格和围栏检查通过；npm run docs:check通过（38行票据生命周期/提交引用/阶段状态）。未修改JSON示例或Mermaid主流程，无需重渲染图。

既有intent脚本中三处预期随合同更新：上下文可直接修正不合法对象字段，不再要求先产生一条不安全格式修复回执；纠错拒绝授权提升时检查实际保存授权和零副作用，不强求工具已执行后再报错；“继续”继承已耗尽额度，需新的明确业务修改才能获得新修改身份。不得用更新脚本绕过权限、预算或业务校验。

## 5. 一轮审阅与风险边界

固定基线完成Standards/Spec双轴唯一全量审阅，之后只复核命名问题及兼容补修：

| 风险 | 审阅/验证结果 |
| --- | --- |
| 纠错弱化合法指令和场景 | Spec P1已修复；初次创建恶意改弱两例拒绝、同输入仅追加场景成功，证据缺口已关闭 |
| 复制旧多类配额触发错误分流 | Spec P2已修复；复制/省略规则均只问业务分配，无额外纠错请求 |
| 首次错误路径及尝试增量遗漏 | Spec P2已修复；首次issues保留、历史attempt*投影及同turn第二次零请求已验证 |
| 写权限、保存未知/迟到、额度重置 | Standards原审阅及兼容补修定向复核无新增P0/P1；同修订回执、写权限/执行围栏和持久上限均保留 |

两轴未留下已确认的待修复发现。审阅均为固定源码和隔离测试证据，不代表真实模型或4217页面验收。

## 6. 后续

OPT-44依赖本次原子保存、业务修改身份、共享修复计数和尝试记录，可继续开发恢复资格与累计预算统一。OPT-45之后再安排明确上限的五项新会话Computer Use；既有质量结论由人工审核，不在本轮重测或改签。
