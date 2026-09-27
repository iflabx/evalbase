# EvalBase 登录与多人协作开源项目调研

调研日期：2026-09-27。范围：Langfuse、Label Studio Community Edition、Dify 自托管。只查官方文档和官方仓库；没有部署或运行这三个产品，不把源码存在等同于所有发行版本默认可用。本报告是研究证据和方案建议，不修改 EvalBase 原型、PRD 或已批准范围。

## 1. 可以先作出的判断

登录、多用户授权、并发写入、实时共同编辑是四件事。为 EvalBase 增加登录页面只解决其中一部分。建议下一版原型先验证“独立账号登录 → 加入项目 → 按角色操作 → 遇到冲突得到反馈”，在线头像、光标同步、同一记录实时合并另列候选能力。

Langfuse 最适合作为账号和成员管理的产品参考；Label Studio 说明邀请链接可以简化加入团队，但 Community Edition 的所有人能看所有项目不适合作为项目隔离模板；Dify 则提供工作区角色、独立令牌生命周期与并发编辑的更完整参考。下述事实和我们的建议分别标注。

## 1.1 面向产品决策的比较

| 项目 | 登录与找回 | 加入团队 | 权限边界 | 多人并发与实时协作 |
| --- | --- | --- | --- | --- |
| Langfuse | 邮箱密码；配置邮件后找回；支持多个 OAuth/OIDC 提供商 | 邮箱邀请，待注册邀请状态 | 组织角色继承到项目；项目覆盖在自托管属于 EE | 本次未证实同记录实时共编；不能据此断言不存在 |
| Label Studio CE | 本地邮箱密码；官方提供命令行重置 | 可重置组织邀请链接；须额外限制公开注册 | 社区版所有人可见所有项目；项目 RBAC 属收费版本 | 标注任务占用锁；不是同一内容实时合并的证据 |
| Dify | 密码默认启用；有邮件重置、可配置社交 OAuth 路径；企业 SSO 单列 | 工作区邀请及角色管理 | 社区单工作区；公开代码有内置角色，Cloud 套餐上限不能移植到社区 | 已读源码有草稿 hash 冲突检查和 Loro/Socket.IO 实时协作；未做部署验证 |

来源及收费边界详见后续各项目章节。这张表比较设计，不构成选型安装建议或容量承诺。

## 2. 固定源码基线

通过官方 GitHub API 查询仓库 HEAD，并下载对应固定 SHA 的文件阅读：

| 项目 | 本次源码基线 | 许可证边界 |
| --- | --- | --- |
| Langfuse | `2ed0d25befdaceba736c08d7e855f3bc4135851e` | 普通目录 MIT；指定 ee 目录另有许可，不能当作整仓库 MIT。见 [LICENSE](https://github.com/langfuse/langfuse/blob/2ed0d25befdaceba736c08d7e855f3bc4135851e/LICENSE)。 |
| Label Studio | `42e585fe287beda0f0f9b7a4c7a365cd6ce451da` | [Community 仓库 LICENSE](https://github.com/HumanSignal/label-studio/blob/42e585fe287beda0f0f9b7a4c7a365cd6ce451da/LICENSE)。商业版能力不能由社区源码推定。 |
| Dify | `725611b2e9a425519e9fcb4dcc579bafea936d27` | Apache 2.0 的修改版，附多租户和前端标识条款；借鉴设计和直接复用代码应区别处理。见 [LICENSE](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/LICENSE)。 |

这些 SHA 是调研时的开发分支快照，不是对稳定发行版或生产质量的认证。

## 3. Langfuse：推荐优先参考的账号与项目模型

**已证实：登录。** 自托管默认启用邮箱密码注册登录，配置事务邮件后可通过忘记密码入口重置；支持可选邮箱 OTP 验证。Auth.js 连接 GitHub、Google、Keycloak、Authentik 等身份提供商，可配置禁用密码登录或强制特定域走 SSO。`AUTH_DISABLE_SIGNUP` 会连带阻止尚无账号的受邀人注册，因此“关闭公开注册”和“只允许邀请注册”不能直接视为同一开关。[自托管 Authentication and SSO](https://langfuse.com/self-hosting/security/authentication-and-sso)

**已证实：身份和会话实现。** `auth.ts` 使用 CredentialsProvider、密码验证函数和 PrismaAdapter，实际会话策略明确为 JWT；session 回调再次查询用户、组织和项目，并检查 `sessionsExpiredAt`。这比仅在浏览器存一个用户对象多出持久身份、失效和权限装配机制。不能仅因 Prisma 中存在 Session 表就声称它使用数据库 session strategy。[固定源码 auth.ts](https://github.com/langfuse/langfuse/blob/2ed0d25befdaceba736c08d7e855f3bc4135851e/web/src/server/auth.ts)

**已证实：数据模型。** User、OrganizationMembership、ProjectMembership 分离；组织成员和项目成员是关联关系，而非在用户上挂一个全局角色。由此同一用户可以在不同范围具有不同访问能力。[固定源码 schema.prisma](https://github.com/langfuse/langfuse/blob/2ed0d25befdaceba736c08d7e855f3bc4135851e/packages/shared/prisma/schema.prisma)

**已证实：角色和邀请。** 组织包含项目；组织角色默认继承到项目，角色有 Owner、Admin、Member、Viewer、None。通过邮箱添加成员并指定角色，未注册用户显示待接受邀请。项目级角色覆盖在自托管中标为 Enterprise Edition；这项限制不能推广为“基础登录、组织成员角色或所有 SSO 都收费”。API Key 绑定项目而非用户。[RBAC 官方说明](https://langfuse.com/docs/administration/rbac)

**已证实：企业功能边界。** 自托管管理总览单独将审计日志、组织创建者限制等标为 EE。评估方案时应按功能查看标识，不能只看仓库中是否出现相应页面。[自托管管理](https://langfuse.com/self-hosting/administration)

**待核实：** 本次没有查到并验证 Langfuse 同一数据记录实时共编、光标同步或其完整并发写一致性承诺；不据此断言不支持。若将其视为 EvalBase 冲突处理参考，需要针对具体写入对象继续读服务端路径并做双会话测试。

## 4. Label Studio：简单团队加入流程与任务级协作

**已证实：账号和加入团队。** Community Edition 使用本地邮箱密码账号；可分享组织邀请链接，也可重置链接令旧链接失效。默认存在独立注册入口，只分享邀请链接不能限制任意注册；需配置 `LABEL_STUDIO_DISABLE_SIGNUP_WITHOUT_LINK=true`。社区版用户具有相同功能并能看到所有项目。[注册和邀请](https://labelstud.io/guide/signup)

**已证实：权限商业边界。** 官方对照表将工作区/项目 RBAC 列为 Community 不含，Starter Cloud 和 Enterprise 提供；自定义权限进一步属于 Enterprise。因此“开源社区支持多人”不等于“开源社区支持按项目隔离”。[版本对照](https://labelstud.io/guide/label_studio_compare)

**已证实：密码与会话。** 社区文档提供服务端 `label-studio reset_password` 命令；本次不把商业云的邮件找回流程套用于社区版。[账号管理](https://labelstud.io/guide/admin_manage)。固定源码采用 Django 认证后端及 REST SessionAuthentication，有会话超时、Cookie 和 CSRF 配置。[settings/base.py](https://github.com/HumanSignal/label-studio/blob/42e585fe287beda0f0f9b7a4c7a365cd6ce451da/label_studio/core/settings/base.py)。OAuth/SSO 社区版端到端可用性本次未证实。

**已证实：多人工作方式。** 官方说明社区及企业版在标注时对任务加锁，防止互相覆盖；这属于分配与锁定任务的协作。文档同时提示同一用户在两个标签页打开标注流可能绕过重叠设置，不应把任务锁理解成所有操作全面串行化或实时共编。[标注与协作者](https://labelstud.io/guide/labeling)

**我们的启发：** EvalBase 的邀请可先支持复制链接，减少依赖邮件服务；链接仍应绑定目标身份和项目，并有到期、撤销、已使用等状态。简单并发场景可以借鉴任务占用提示，但应验证锁到期和浏览器异常退出的恢复路径。

## 5. Dify：工作区角色、令牌生命周期及实时协作源码

**已证实：自托管与收费范围。** 官方产品页将 Community 定位为单工作区，自托管企业方案包含多工作区和 SSO。云版成员页面给出的 1/3/50 人套餐上限属于 Cloud，不能搬成社区自托管限制。[自托管产品对照](https://dify.ai/pricing/dify-enterprise)、[Cloud 成员管理](https://docs.dify.ai/en/cloud/use-dify/workspace/team-members-management)

**已证实：身份入口。** 当前公开源码配置默认开启邮箱密码，邮箱验证码和 GitHub/Google 社交 OAuth 默认关闭；可以看到相应开关和 OAuth 路由。因此“企业 SSO”与“公开源码中的社交 OAuth”应分开讨论。仅有配置/路由仍不足以承诺任何特定发行包已配置好外部登录。[feature 配置](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/configs/feature/__init__.py)、[OAuth 路由](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/controllers/console/auth/oauth.py)

**已证实：密码恢复。** 公开源码包含发送重置验证码、校验及重置流程，并处理邮件发送限流与无效 token；仍需配置邮件基础设施。[forgot_password.py](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/controllers/console/auth/forgot_password.py)

**已证实：角色、邀请和会话。** Account、Tenant、TenantAccountJoin 分离；角色枚举包括 Owner/Admin/Editor/Normal/DatasetOperator，角色启用和新 RBAC 受配置影响。成员接口可邀请、改角色、移除、转移所有权，后端校验权限；Cloud/Enterprise 上限按部署版分别判断。令牌服务生成 access/refresh/CSRF token，refresh token 存 Redis并轮换；登录控制器通过 Cookie 设置或清除凭据。[账号模型](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/models/account.py)、[成员控制器](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/controllers/console/workspace/members.py)、[账号服务](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/services/account_service.py)、[登录控制器](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/controllers/console/auth/login.py)

**已证实：并发保存。** 工作流草稿保存先锁数据库行、比较 `unique_hash`，不一致抛出 WorkflowHashNotEqualError。协作图保存避免覆盖独立持久化字段。这是具体路径证据，不代表所有对象拥有相同冲突机制。[workflow_service.py](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/services/workflow_service.py)

**已证实：实时协作代码。** 当前主分支包含 Loro CRDT、Socket.IO、在线用户和光标同步逻辑；服务端加入协作房间会检查用户、租户及应用权限。`ENABLE_COLLABORATION_MODE` 在所读配置中默认 true，前端同时检查该开关和编辑权限。不能再笼统说 Dify 没有实时协作。尚未验证它对应的稳定发布版本、实际部署及所有边界行为。[CRDTProvider](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/web/app/components/workflow/collaboration/core/crdt-provider.ts)、[前端 hook](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/web/app/components/workflow/collaboration/hooks/use-collaboration.ts)、[协作服务](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/services/workflow_collaboration_service.py)、[配置](https://github.com/langgenius/dify/blob/725611b2e9a425519e9fcb4dcc579bafea936d27/api/configs/feature/__init__.py)

## 6. EvalBase 当前基础与迁移差距

本节依据开发仓库提交 `70c2272f43927d7bb4e1ac632091a39d7b2cd955` 的静态源码检查；没有连接数据库读取用户数据，也没有启用或测试多人模式。

| 当前证据 | 对下一阶段的含义 |
| --- | --- |
| [PRD 第 3、8 节](../PRD-evalbase-v1.md)和[领域合同](../../CONTEXT.md)仍定义唯一 Owner，登录、成员和多人协作不属于当前产品范围。 | 本报告只提出后续选择。未来确认原型后，应更新这些权威规则及受影响合同，再建立实施 Ticket。 |
| 正式前端遇到会话 401 会自动 POST 空对象创建会话；后端在 soloOwnerMode 下把该请求绑定为 `user_owner`。见[前端会话入口](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/frontend-v3/src/services/workspace.ts#L229)、[后端会话入口](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/server/app.ts#L1015)。 | 真实登录需要一起替换前后端的自动 Owner 绑定。增加登录页面或路由守卫不足以完成身份隔离。 |
| 后端已有随机会话 token、数据库存储 token 哈希、8 小时有效期、CSRF token，以及 HttpOnly / SameSite Cookie；该处 Cookie 的 `secure` 当前为 false。见[会话创建与验证](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/server/app.ts#L1064)。 | 可以评估复用服务端会话机制，补齐退出、撤销、密码重置后失效策略及 HTTPS 下 Cookie 配置；无需因 Langfuse 使用 JWT 就改为 JWT。 |
| `project_member` 支持 owner/editor/viewer 到 read/write/export/manage 的映射；editor/viewer 又被标记为测试身份。会话装配仍读取固定 `project_demo`。见[权限模块](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/security/project-access.ts)、[身份装配](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/server/app.ts#L1083)。 | 已有部分授权基础，但必须分开真实用户、测试身份和每个项目的成员角色；不能通过打开测试身份开关交付多人功能。 |
| 数据库迁移中存在草稿租约、revision 和每测试集单活跃草稿约束，源码也包含租约/修订冲突检查。见[迁移定义](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/db/migrate.ts#L976)、[冲突检查](https://github.com/iflabx/evalbase/blob/70c2272f43927d7bb4e1ac632091a39d7b2cd955/src/server/app.ts#L7550)。 | 这些历史机制在当前正式路径中的覆盖尚未完整审计，不能据此宣称已支持多人共同编辑。选定编辑模型后再核对是否能复用。 |

技术建议：沿用当前 Fastify、PostgreSQL 体系评估身份与授权模块，不直接移植 Langfuse 的整个 Next.js/Auth.js 页面和服务端结构。第三方项目提供的是可借鉴的行为、模型与验证路径。

最低实施依据可参考 OWASP：身份校验与资源授权分开，每次请求验证访问范围；认证状态变化时处理会话轮换和失效，Cookie 按部署使用 Secure/HttpOnly/SameSite。见[Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。本次未对项目做完整安全审计。

## 7. 对 EvalBase 的设计建议（尚未批准）

以下是本报告提出的建议，不是第三方产品事实或已批准的新需求。

第一阶段建议范围是独立账号、独立会话、邀请成员、项目角色和冲突反馈。优先审计项目现有的会话、project_member 能力模型与草稿 revision/lease 基础，复用经过验证的部分；不能直接启用测试身份作为登录。是否额外增加组织层应由是否需要多个独立团队决定，不为了模仿 Langfuse 提前引入第二层管理。

建议原型展示这些完整路径：

1. 登录、错误凭据、退出、会话到期后重新登录；恢复原来访问页面。
2. 首位管理员初始化，以及受邀用户设置账号；邀请过期、撤销、邮箱不匹配、重复加入。
3. 项目成员列表、邀请、角色调整、移除成员；保留历史操作归属，避免删除账号连带丢失业务数据。
4. Owner/Editor/Viewer 的候选能力矩阵；尤其明确下载、发布版本、永久删除和管理成员分别归谁。
5. 没有项目权限的深链接、被移除后继续操作、角色降级后已打开页面的反馈。
6. 两个用户同时编辑同一草稿的占用/冲突提示、保留本地未提交内容、刷新或另存处理；发布、删除同样要考虑竞争。

如果团队已有统一身份提供商，再评估 OIDC；没有时可先用邮箱密码加管理员邀请。密码恢复方式、邮件是否可用应先定，再绘制对应界面。多人在线首阶段不必引入 CRDT/WebSocket；若用户明确需要同一条数据实时共同编辑，则单列设计和实现成本。

## 8. 开发前待确认与后续验证

待确认问题：账号由管理员邀请还是允许公开注册；一个账号能否加入多个项目；是否需要独立组织；首批角色和权限；是否已有学校/实验室 SSO；邮件是否可用；“多人在线”是否包含头像/在线状态或实时共同编辑；旧单人数据归属谁。

既有 `user_owner` 及其创建的数据应在迁移时明确归属于哪个真实账号和项目；应保持历史记录可追踪，不能把全部旧数据默认为任意新注册用户可见。所有下载、CSV 缓存、异步任务结果和后台管理入口也必须纳入服务端授权审计，不能只限制前端页面按钮。

开发验证应覆盖双浏览器独立账号、直接 API 越权、跨项目读取及导出、撤权后的旧会话、邀请重放、恢复密码后会话失效策略，以及两人同时编辑/发布/删除。Mock 原型能验证交互，不能证明后端身份隔离、会话撤销或冲突处理已经正确。

本次研究没有改原型，没有更新产品承诺，没有创建开发 Ticket，也没有部署或发布。
