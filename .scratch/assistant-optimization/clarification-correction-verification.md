# 连续错误澄清纠正：修复与验收记录

## 范围与版本

- Owner 已授权最小修复、连续错误澄清回归、4217更新及一次独立有上限的新会话 Computer Use 验证。
- 基线：dedc2eb16aa93c68ca44c00ddaf47cdc7de0977d（运行代码2e427b8）；修复代码：0b871335e6e19832cb345cbee8d85541f42cf77d；分支 codex/assistant-optimization。未合并或推送。
- 沿用AI SDK、既有工具/数据库/Worker；没有新表、公开API、额外分类模型或UI样式改动。内容质量继续由人工审核，本轮不扩展为质量评测。

## 原因与最小修复

原模型连续把“先给方案”输出为开工或命名确认。服务端正确拒绝，但业务错误以工具结果返回，未进入SDK格式修复；相同错误提示被两次无进展守卫立即终止。旧诊断还把无进展合并为预算耗尽。

1. 为原有写入前“不必要规划澄清”校验使用专用错误标识，并保留无副作用回执判断。
2. 当前轮只规划、错误明确无副作用时，在现有循环中最多安排两次带原请求/文档上下文的强制plan_task纠正；原模型步数、工具次数、截止时间及任务预算不变。持续失败仍停止；不自动执行或采用。
3. 先满足既有附件读取前置条件，再消费纠正机会；已读文档之后仍保留待纠正状态。真正文档缺失、歧义及范围/数量冲突仍允许业务澄清。
4. assistant_no_progress 显示 workflow_stalled；实际限额仍显示 budget_exhausted，避免把内部纠正失败解释成用户预算不足。

## 定向验证

- 红：公开会话接口复现连续两次错误确认（相同/不同问法），正确方案尚未被消费即assistant_no_progress，零生成副作用。日志：opt42/planning-clarification-red.log。
- 绿：`python3 .scratch/assistant-optimization/opt39/run-tests.py npx vitest run tests/integration/assistant-intent.test.ts tests/unit/assistant-diagnostics.test.ts --exclude **/.scratch/** --reporter=dot`（实际命令对exclude参数加shell引号），56项通过，42.82秒。
- 新回归覆盖：连续两次错误后真实保存两份各2条方案；不同问法；错误发生于读取文档前；持续失败有界停止；真实缺失仍澄清；规划零草稿/处理任务。断言模型收到强制工具选择、原短提示与纠正上下文，并核对真实持久交付数量。
- 根类型检查、五个受影响文件ESLint、git diff --check通过；固定SHA完整应用构建通过。
- Standards审阅0项；Spec审阅发现“纠正早于附件读取”P2，已修复并定向复核关闭。
- 首轮命令未排除构建归档，额外发现旧快照测试；已停止该测试进程树，最终命令明确排除.scratch，只以上述56项当前代码结果为通过依据。

## 4217更新与数据保护

- 仅替换Web/model-worker，postgres/minio/普通worker容器保持。
- /health、/health/ready、前端资源通过；运行SHA与修复SHA一致。
- 15张业务表前后数量和内容指纹一致；验收数据、历史失败、原预算保持。私有数据库备份未提交版本库。
- 细节保存在clarification-correction/checkpoint.json及六份旧预算的old-hashes.json。

## 独立Computer Use验证

- 使用同模型qwen-new、同修复SHA、同10行物流说明，在4220隔离数据库复测；4217保留原验收数据。
- 一个新会话，物流查询/修改地址两个测试集各2条；先方案、再执行、用户固定确认采用，刷新核对。无正式发布，不重跑旧完成部分。
- 固定上限：40次实际模型HTTP请求、累计活动时间600000ms、最多4条生成、最多1个会话；规划、生成、审核、纠错均计数。旧六份预算未重置。
- 当前状态：待浏览器恢复。已创建独立限额账本，实际模型请求0次；浏览器安全策略阻止读取旧错误页，已请求Owner手动打开http://127.0.0.1:4220/。尚不能宣称Computer Use通过。
