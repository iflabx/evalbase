# V2-01：账号、初始化与项目权限基础

Status: ready-for-agent
Implementation: not-started

Blocked by: 无实现依赖；执行需 Owner 授权本 Ticket 或批次 A。
Checkpoint: A（中间 Ticket，不单独创建人工 checkpoint）

## Outcome

用户可以在空实例初始化唯一管理员、注册和登录；管理员管理全部项目，普通账号仅访问所属项目。已有 v1 身份和数据有受测升级路径。

## Required reading

- [Implementation Spec](../spec.md)，含统一执行协议、依赖、测试归属及 checkpoint 资源回收。
- Spec §1 链接的 PRD、CONTEXT、架构、测试计划、冻结原型与 donor 复用合同。
- [ADR 0012](../../../docs/adr/0012-v2-account-and-project-authorization.md)、[ADR 0002](../../../docs/adr/0002-postgres-minio-persistence-roles.md)。

## Scope

- 建立 admin/user 与逐项目 editor/viewer 分离的模型，复用既有密码和会话；管理员无需成员关系即可创建/管理全部项目。
- 完成初始化状态、首次管理员注册、账号注册、登录、登出、会话恢复及过期 UI/API；移除自动空会话登录，邮箱不验证，错误保留表单输入并即时提示密码规则。
- 梳理现有全部项目资源、来源和下载请求，按真实资源所属项目授权；普通用户无项目时显示真实空态。
- 提供旧 Owner 邮箱绑定迁移与备份恢复说明，保留 ID/密码哈希/历史引用；启动不覆盖密码、不插入生产测试账号。仅在隔离夹具演练。

## Acceptance Criteria

1. 两个首次注册并发只成功一个管理员；初始化完成和重启后不能再次公开创建管理员。
2. 注册普通账号不获得项目权限；伪造角色、跨项目 ID、空请求或过期会话均不能绕过授权。
3. 不属于任何项目成员的管理员可查看和管理所有项目；合成 editor/viewer 分别按既定权限读取和写入。
4. 登录刷新有效、登出后旧会话失效；密码不写入日志/前端持久存储；Origin/CSRF 和部署 cookie 配置有效。
5. 旧数据升级和失败恢复保留身份及版本可读性；歧义邮箱/身份停止迁移并明确报告，不公开认领。

## Necessary tests

AUTH-01–05、ACL-01–03、UPGRADE-01–02；受共享授权影响的现有上传、导出及删除接口定向回归。首个 red 建议：新空实例两个初始化请求只能产生一个可登录管理员。

按实际 diff 选择受影响 typecheck、lint、frontend build 和文档检查。执行前记录具体命令与公共测试边界；完成后记录真实结果、未测项及原因。Standards/Spec 复审清除 P0/P1 后提交，不用单纯按钮禁用或 Mock 代替服务端证据。

## Frontend parity

管理员注册、账号注册、登录、项目列表空态、登出；按冻结原型的字段顺序和错误提示，直接复用 frontend-v1 组件样式。成员邀请/个人设置在 V2-02 交付，本 Ticket 不挂可点击假设置页。

实施前在本节补充 Ticket-local 对照表，逐项记录字段、顺序、标签、启用条件、空/错态和排除项；正式前端仅 frontend-v3，frontend-v1 只读。

## Owner checkpoint

完成必要验证和复审后提交并报告，为 V2-02 提供账号夹具。已授权整个 A 时连续进入 V2-02；仅授权本 Ticket 时停止报告。A 的最终浏览器环境由 V2-02 建立。

## Out of scope

不实现邀请、个人资料 UI、实时在线或共享草稿；不增加 SSO、邮箱验证码、密码找回或管理员管理页面。

## Comments

- 2026-09-28：仅创建实施 Ticket，尚未执行测试或开发。完成后在此记录实现 SHA、验证、复审和批次验收证据，并同步 Spec 进度表。
