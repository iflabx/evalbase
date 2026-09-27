# v2 分离全局账号和项目授权

- Status: Proposed
- Date: 2026-09-28
- Scope: v2；不追溯改变 v1 已交付合同。
- Product decision: [Owner 已确认规则](../reviews/login-multiuser-owner-decisions.md)

## 背景

v1 的单人 Owner 和固定项目授权不适合多账号。用户已确认仅有全局管理员，管理员管理所有项目，不存在项目管理员。

## 决策

将全局 admin/user 与项目 editor/viewer 分离，稳定 user ID 保留历史归属。所有数据访问由资源所属项目授权，管理员显式全局覆盖。新安装以数据库唯一初始化状态创建首位管理员；旧数据升级通过受控迁移绑定既有 Owner 邮箱，不能公开注册认领。

密码和会话复用既有服务端设施；本期不引入外部身份平台。自助注册不验证邮箱是已确认产品规则，不据此推导邮箱所有权已被验证。邀请仅面向已注册账号，按其登记邮箱定位；接受时校验登录账号与邀请目标一致。

## 取舍

该方案减少身份基础设施，但本期没有 SSO、邮箱验证和自助密码找回。未来接入外部身份时必须保留 user ID，并增加独立身份绑定，不能把邮箱当永久不可变主键。现有部署必须完成可回滚的身份迁移。

## 依据与后果

[PRD](../PRD-evalbase-v2.md) 是业务权威；[架构](../architecture/evalbase-v2-architecture.md) 定义迁移及授权事务；[测试计划](../test-plan-evalbase-v2.md) 的 AUTH/ACL/INV/UPGRADE 验证约束。技术实现提案仍待评审，不能将 Proposed 误记为已实现。
