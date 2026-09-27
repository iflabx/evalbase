# EvalBase v2 实施规格与进度

Status: ready-for-agent
Implementation: not-started

日期：2026-09-28。范围基线：文档提交 52413dc，应用 main 70c2272f43927d7bb4e1ac632091a39d7b2cd955。
本次 Owner 授权创建 Ticket，未授权开始实现、合并、推送或部署。

## 1. 合同与必读材料

实施前完整阅读当前 Ticket、根 [AGENTS](../../AGENTS.md)、[PRD v2](../../docs/PRD-evalbase-v2.md)、[CONTEXT](../../CONTEXT.md)、[v2 架构](../../docs/architecture/evalbase-v2-architecture.md)、[v2 测试计划](../../docs/test-plan-evalbase-v2.md)及 Ticket 指定 ADR。
继承能力参见 [v1 PRD](../../docs/PRD-evalbase-v1.md)、[Phase 1A 架构](../../docs/architecture/phase1a-architecture.md)。
前端对照 [冻结记录](../../docs/prototypes/phase1a-login-multiuser-vnext-freeze.md)及 [frontend-v1 复用矩阵](../../docs/architecture/phase1a-frontend-reuse.md)。

本规格只分配实现归属和验收顺序，不复制或扩大 PRD。v2 的明确变更优先于旧 v1 的无登录、无设置、无成员、无可见草稿规定；其他 v1 行为继续继承。原型与确认后的 PRD 不同时，以 PRD 为准。PRD/架构保留 Draft 标识，ADR 0012/0013 保留 Proposed；本次创建 Ticket 不伪造技术决策已批准或已实现。执行时按现有规则核对并记录采用的技术决策，产品变更另行确认。

## 2. 四张 Ticket，三个功能验收批次

| Ticket | 完整交付内容 | 开发依赖 | 人工 checkpoint |
| --- | --- | --- | --- |
| [V2-01](issues/01-accounts-and-authorization.md) | 初始化、注册登录、账号迁移和服务端项目权限 | 无实现依赖 | A 的中间 Ticket，不单独验收 |
| [V2-02](issues/02-members-invitations-and-settings.md) | 已注册用户邀请加入、成员管理、个人资料和信息 | V2-01 自动化及复审完成 | A：账号与项目协作入口 |
| [V2-03](issues/03-persistent-draft-workspace.md) | 全页共享草稿、来源选择、保存继续、删除、唯一发布及回收联动 | A 通过 | B：完整草稿工作流 |
| [V2-04](issues/04-realtime-collaboration-and-attribution.md) | 在线头像、编辑位置、实时同步、冲突交互和作者展示 | B 通过 | C：双人实时共同编辑 |

编号为新 feature 下的 V2-01 至 V2-04，区别于已完成的 Phase 1A 01–38。不新增“纯测试/最终整合”Ticket；最终受影响流程验收包含在 C。

### 执行授权与批次边界

Owner 说“开发批次 A”或“开发账号与成员功能”时，授权连续完成 V2-01、V2-02。V2-01 通过自动化检查、Standards/Spec 复审并提交后可继续 V2-02，中间不要求人工 checkpoint 或重复授权。若仅指名 V2-01，则只完成该 Ticket 并报告它属于 A 的中间结果。批次 B/C 同理。

每批使用同一个 codex/ 功能分支；V2-01/02 可分别提交，A 的验收固定在 V2-02 最终 HEAD。同批中间 Ticket 的阻断性测试或复审问题必须先修复；未解决不能以“稍后统一验收”绕过。A/B/C 之间必须完成前一批 Owner 验收，下一批再按用户授权启动。创建本清单不授予上述执行授权。

每次实施继续使用 implement + ponytail full、公共行为 TDD、必要验证和 Standards/Spec 复审；高风险身份迁移、发布及永久删除按既有协议完成相应 Closure Review。各 Ticket 必须先列受影响路由 reused/narrowed/retired 和 frontend-v1/原型 parity 表。

## 3. 实现责任与阶段完整性

所有前端 Ticket 必须执行 [PRD §7](../../docs/PRD-evalbase-v2.md#7-视觉与实现边界) 的严格 UI 对齐要求。Ticket-local parity 表须列出受影响页面与已确认差异；checkpoint 交付前按冻结原型逐页核对布局、控件、文案、状态和交互，并保存截图或浏览器核对证据。功能测试通过不能替代 UI 对齐验收。

- V2-01 建立身份和授权事实；V2-02 复用它交付完整入组流程，不另造身份体系。
- V2-03 交付可保存、可重新打开、可发布的真实草稿，不把发布按钮留给后续 Ticket。同字段 revision 检查、行删除竞争、草稿级唯一发布及可靠恢复在本 Ticket 已成立；后续实时推送不替代数据正确性。
- V2-03 保存修改者稳定 ID 和时间，并在正式发布时保留归属，避免 V2-04 上线前产生无法归属的新数据；V2-04 负责记录/字段作者的完整展示和实时刷新。既有历史未知仍显示“未记录”。
- V2-03 已提供冲突响应及保留输入、重新加载/解决的基本界面；V2-04 将其连接到实时事件，扩展到完整的双人逐字段交互。
- B 的阶段限制只有尚无自动实时推送、在线头像及完整字段作者展示；两账号刷新后可读共享保存结果，不能静默丢更新。这些属于明确分期，不是 v2 最终能力削减。
- V2-04 完成所有实时 UI，并在最终 C 重验跨用户同草稿发布、撤权和删除事件；不能重新实现第二套发布协议。
- 项目在线状态与草稿编辑位置分开授权：查看者可按既有项目权限显示在线状态，但不读取草稿正文或草稿编辑位置。
- 未到当前阶段的控件按 Ticket 记录为不展示或不可操作，不使用 Mock、假接口或假在线头像制造完成印象。

## 4. 需求与测试归属

| PRD | 主实现 Ticket | 验证 |
| --- | --- | --- |
| FR-01 初始化/会话，FR-10 身份升级 | V2-01 | AUTH、UPGRADE |
| FR-02 管理员权限 | V2-01；成员变更在 V2-02 | ACL |
| FR-02 邀请，FR-03 设置/信息 | V2-02 | INV、PROFILE、ACL |
| FR-04 草稿，FR-05 编辑/来源，FR-07 发布，FR-09 删除 | V2-03 | DRAFT、EDIT、PUB、DELETE、REG |
| FR-06 并发正确性 | V2-03 保存/发布边界；V2-04 实时链路 | COLLAB、PUB |
| FR-08 归属 | V2-03 持久事实；V2-04 展示 | TRACE |
| FR-10 草稿/协作持久化与兼容 | V2-03/V2-04 | UPGRADE、REG |

测试用例的详细合同以测试计划为准，不把所有用例在每张 Ticket 重跑。共享授权、迁移、发布、永久删除等风险边界选取必要回归；C 集中跑受影响闭环并记录未测项。

## 5. Checkpoint 交付与资源回收

每批最终 HEAD 启动独立 Web/Worker/frontend-v3 和隔离持久化资源；实际名称含批次与 owner-checkpoint。仅使用空闲 loopback 端口，保持正式实例、原型服务和服务器其他项目不变。校验 /health.git_sha、/health/ready 及一次前端同源 API；实际交付时提供 URL、隧道命令、合成账号、数据编号和短步骤。

- A：新安装初始化→注册→管理员邀请→信息接受→项目权限→修改个人资料→登出。另用合成旧数据验证升级；不用正式数据库演练。
- B：管理员或编辑者创建两份新建草稿→保存退出继续→从两个父版本分别派生→跨页选择、行内 Metadata 空值→发布→删除草稿→合成数据回收恢复。双人唯一发布及故障注入提供自动化证据。
- C：两个独立浏览器身份同时编辑同草稿/不同草稿→看在线和编辑位置→不同字段并行→同字段冲突→断线重连→双人发布同一草稿→角色降级→检查字段归属、来源与 CSV。普通同源标签页共享会话，不冒充两个真实账号。

每批 Owner 明确通过后记录接受 SHA、证据和资源清单，释放本批独占容器、网络、数据卷、种子数据和端口，并检查残留。下一批从可重建夹具重新准备，不依赖已回收环境。只删除核实属于本批的资源，保留验收日志和固定提交证据。验收不自动授权合并、推送或正式部署。

## 6. 进度台账

| Ticket | Implementation | 实现 SHA | checkpoint |
| --- | --- | --- | --- |
| V2-01 | in-progress | 1726f85 | A，待 Owner 验收 |
| V2-02 | in-progress | 1726f85 | A，待 Owner 验收 |
| V2-03 | not-started | - | B，待开发 |
| V2-04 | not-started | - | C，待开发 |

Status 是 triage 标签，Implementation 才是实现生命周期。每次完成更新本表和对应 Ticket Comments，引用真实实现 SHA、验证命令、复审与批次结果。v1 的 progress 台账保留已交付历史，不写入 v2 假完成记录。

## Comments

- 2026-09-28：按 Owner 要求创建少量功能 Ticket；同一功能多 Ticket 共用 checkpoint。当前所有实现均未开始。
