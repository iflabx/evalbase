# v1 Owner 绑定为 v2 管理员

本操作只针对已存在 v1 `user_owner` 的实例。空实例直接在首次访问页面创建管理员。请在维护窗口执行，不在正式实例上自动创建账号、覆盖密码或猜测邮箱归属。

1. 停止 Web、Worker 和其他写入入口，记录当前代码 SHA 与部署配置。对 PostgreSQL 做一致性备份，例如 `pg_dump -Fc --no-owner --no-privileges "$DATABASE_URL" > evalbase-before-v2.dump`；同时备份对应 MinIO bucket 和配置。将备份恢复到**隔离**实例，验证库表、项目、测试集、版本和原始文件可读。
2. 核实旧身份恰好有 `user_owner`，确认目标邮箱归属及大小写规范化后没有冲突。存在不明账号、多个 Owner 或无法确定归属时停止，先人工核对。脚本也会拒绝这些情况。
3. 在隔离恢复实例先演练：`LEGACY_ADMIN_EMAIL='admin@example.com' npm run db:bind-legacy-admin`。验证 `user_owner` 的 ID 和密码哈希未变、管理员邮箱登录成功、旧项目与版本可读、账号注册和邀请权限正确。
4. 正式窗口在同样备份和核对后，设置目标数据库 `DATABASE_URL`，执行同一绑定命令。确认登录和旧数据，再启动 v2 Web、Worker。脚本只绑定旧 Owner，不会创建新管理员或更改其密码；重复运行会拒绝。
5. 失败且尚无 v2 写入时，保持写入关闭，从成对的 PostgreSQL 与 MinIO 备份恢复，并复查版本内容。v2 已产生写入后，不要直接用旧程序解释新身份数据；先评估并制定数据恢复方案。

本步骤的隔离夹具测试位于 `tests/integration/v2-accounts.test.ts`。部署命令和备份位置由实际运行环境决定，不在脚本中硬编码。
