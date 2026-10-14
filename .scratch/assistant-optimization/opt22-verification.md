# OPT-22 验证记录

## 范围与版本

- Ticket：[OPT-22](issues/22-assistant-tool-and-plan-contract.md)，2026-10-14 获 Owner 单张开发授权；沿用 `codex/assistant-optimization` 和同一 4217。
- 实施基线：`1e8ec1417ee8f77d982e6068d2c652c178e3b513`；主实现 `5343e34fa3c004e388a7ae41661e0ab35385ce97`；最终代码 `b59f3cbe73ad1c361f7a0314469c5669ea11ce85`。
- 本张收敛工具、计划和生效要求合同；无新增依赖、数据表、公开 API、前端页面或 Worker 配方。沿用 frontend-v1 的当前界面。Implementation completed、Owner pending，OPT-23–25 未实施。

## 实现与安全边界

模型工具按持久阶段和当前权限提供，读取与合法修复通道保留。薄参数在完整业务校验之前绑定实际来源、固定输入、当前运行、所选候选批次、已创建草稿和成对的预览回执。省略不清除，显式撤销不恢复旧值；提交来源只能处于当前声明范围，处理子集不扩大范围。Metadata 键限制继续由原冻结输入和领域事务继承。

独立要求只清理首尾空格、去除完全相同项并稳定比较，资产集合按真实 ID 归一；有序步骤不排序，自由文本实质变化不忽略。背景冻结要求使用同一比较口径。旧任务仅在旧键确实对应当前事实时兼容新键，不改写历史任务或回执。

规则实质改变与待执行确认失效在同一 session fence 内提交，阻止旧确认继续写入。已提交但丢响应的操作仍依据原幂等键恢复真实回执；无可证回执不能冒充成功。未知写绑定、当前权限、字段保护、数量检查和 OPT-21 的累计预算保留。

两处参数校验共用具体字段反馈，缺少参数与额外字段分别说明；额外字段名最多 80 字。删除受影响的重复模型说明和 anyOf 参数兼容分支，旧完整参数记录仍可读取。

## 定向回归与审阅

- 修复前：要求重排、薄参数和阶段合同单测失败；新增四项公开 HTTP 情景在基线代码失败。日志为 `opt22-contract-red.log`、`opt22-public-red.log`。
- 主实现：24 项受影响单测、16 项公开 HTTP 通过。覆盖计划/执行、固定范围、冲突要求、查看权限、既有确认、连续错误和未知写入，见 `opt22-final-verification.log`。
- 确认竞争与 Metadata 组 5 项通过：旧确认已领取但未提交时拒绝；真实提交后模拟丢回复，恢复原发布回执；选中较早候选批次时处理该批次并保留 Metadata 局部键限制。只在隔离测试数据库注入时序，见 `opt22-race-and-metadata.log`。
- 最终基线发现 A3/A4 旧 fixture 依赖全量工具和 selection 必填，按阶段投影改为同一回合声明当前动作，保留原范围、权限、修订、过期、幂等和确认断言；相邻 4 项通过，见 `opt22-a3-a4-contract-final.log`。
- 参数反馈新增回归先红后绿，含合法纠正、连续 SDK 错误的顺序/批量两种情景和冲突规则正常对照，共 4 项通过，见 `opt22-field-hint-red.log`、`opt22-field-hint-green.log`。
- 根 typecheck、受影响 ESLint 和差异检查通过。Standards/Spec 最终审阅发现的确认竞争、真实回执恢复、旧批次引用、Metadata 键限制和背景要求重排问题已关闭；最终仅针对上述补修复核，无剩余相关 P0/P1。

## 短请求结果与限制

统一入口为 `scripts/assistant-baseline.ts`，固定合成 8 条资料；模型为配置修订 1 的 `qwen3.8-27b-un`。测试运行器只读使用加密连接配置，0600 临时文件自动删除，隔离数据库/桶清理，不对 Owner 数据生成内容。

| 情景 | 基线 `1e8ec14` | 主实现 `5343e34` 首轮 | 首轮参数失败/同回合恢复 |
| --- | --- | --- | --- |
| A2 先方案再执行 | 未完成，2 条提示 | 未完成，2 条提示 | 2 / 1 |
| A3 清理空白 | 完成，1 条提示 | 完成，1 条提示 | 0 / 0 |
| A4 扩写 8 条 | 完成，1 条提示 | 未完成，1 条提示 | 1 / 0 |
| A6 改为 4 条 | 完成，2 条提示 | 未完成，2 条提示 | 1 / 0 |

完整原始结果见 [修复前小样本](opt22-before-short-real.json)、[首轮小样本](opt22-after-short-real.json)。修复前旧脚本没有参数失败/恢复计数，不能推测为 0 或计算其下降比例；本轮恢复数仅指同回合成功的同名工具，不表示任务或语义完成。

针对失败另执行一次小范围诊断，见 [诊断结果](opt22-diagnostic-real.json)：A2 仍未完成，模型提供的预览引用无法找到；A4 本次完成；A6 仍未完成，模型在 select_candidates 传入不支持的顶层 count/seed。由此补修额外字段反馈，未放宽引用或范围校验，也未挑选成功轮次替换首轮结果。模型调用存在波动，这些少量运行不能证明一般成功率提升；内容语义仍待人工审核。

最终固定代码的 [可控 A2/A3/A4/A6/A9/A10](opt22-controlled-final.json) 六组通过。补修后只重跑直接受影响的 [真实 A6](opt22-final-a6-real.json)：2 条用户提示达成目标，1 次参数失败后同回合恢复，约 34.5 秒。没有重跑全部真实矩阵来筛选更好结果；A2 仍有未完成证据。可控测试只证明合同断言，goalCompleted 保持 null；不冒充模型内容完成率。脚本新增 A9 定向映射，因此整套定义 hash 改变；A2/A3/A4/A6 的短提示和 synthetic-eight-v1 输入保持一致。

固定版命令：

```sh
GIT_SHA=b59f3cbe73ad1c361f7a0314469c5669ea11ce85 python3 .scratch/assistant-optimization/opt22-baseline-runtime.py --mode=controlled --cases=A2,A3,A4,A6,A9,A10 --output=.scratch/assistant-optimization/opt22-controlled-final.json
GIT_SHA=b59f3cbe73ad1c361f7a0314469c5669ea11ce85 python3 .scratch/assistant-optimization/opt22-baseline-runtime.py --mode=real --cases=A6 --output=.scratch/assistant-optimization/opt22-final-a6-real.json
```

## 4217 与数据保留

固定镜像构建通过，限制 1 CPU、2 GB；同一 `evalbase-agent-owner-checkpoint` 的 Web 切到 `evalbase-agent-checkpoint:b59f3cbe73ad`。`/health`、`/health/ready` 和本机 4217 转发均确认上述代码 SHA，PostgreSQL/MinIO 正常。

切换前已保存权限 0600 的数据库备份 `opt22-owner-before-b59f3cbe73ad.dump`；16 张业务表的数量及内容指纹完全一致。保留 2 账号、18 数据资产、17 草稿/1548 条记录、62 处理任务/82 运行、14 助手会话/107 回合和 8 正式版本等验收数据。数据库、对象存储、普通 Worker 和 model-worker 的容器与存储挂载保持；两项 Worker 仍为 `4af93adaeda7609e3177fe2013e4091d6320acdc`。

真实 1440px 浏览器读取处理列表及最新会话均为 200/可见，旧无诊断失败可展开，输入保留、0 页面异常。只登录/登出，没有发送助手消息或采用成果。切换与现场证据见 `opt22-final-build.log`、`opt22-final-baseline.log`、`opt22-checkpoint-final.log`，运行数据指纹保存在服务器未入库的 `opt22-owner-before.json`/`opt22-owner-after.json`。仅更新原 4217，不切换生产、不合并 main、不推送。

## Owner 简短验收

1. 打开原会话，核对旧要求、操作回执和候选仍可查看。
2. 对少量资料发送“先设计方案，先不执行”，再发“按方案执行”，核对按当前方案实际提交。
3. 交换独立要求顺序，已完成读取不应重做；改变数量或字段后，旧确认应失效，真实成果保留。
4. 选中较早批次的少量候选，要求只修改指定 Metadata 键，核对未选记录及其他字段保持。

确认竞争、查看权限和未知写入已在隔离自动回归验证，Owner 无需人为破坏连接或数据。人工验收另记。
