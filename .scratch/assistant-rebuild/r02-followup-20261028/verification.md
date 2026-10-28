# REBUILD-02 追加架构补强验证（2026-10-28）

- 基线：11a9e9f；实现：3c06d8477a4e21388b3f5e719cfc50eb392fe4cf；分支：codex/assistant-rebuild。
- 范围：[R02-A1～A3](../issues/02-deepagents-session-and-tool-host.md)。原范围通过证据保留，本记录只关闭追加结构合同；03的调度抽离及完整后台入口补强仍未完成。
- 环境：仓库锁定依赖、Node24、真实 LangChain/Deep Agents SDK、本地受控HTTP Provider、每轮独立 formal_session_* / formal_execution_* 测试库及合成对象。测试结束清理其自建库；未迁移或读写验收库。外部模型请求0，未创建真实活动、运行CU或更新隔离预览/4217。

## 实现与责任

- session-model.ts 集中 ChatOpenAI 创建及传输/流观察，使用 BaseChatModel 的现有SDK能力。保持temperature/maxTokens/maxRetries/streaming等配置；HTTP尝试沿原 ExecutionStore reserve/outcome、关联身份及事件计量，缺usage为null。摘要、正文和纠错的 AsyncLocalStorage 分类保留，不增第二账本。
- session-context.ts 每次由正式反馈中间件重建当前事实，读取当前要求/范围、执行投影、可见附件；构建前后比对会话revision及requirements_revision，变化即中止，禁止发送混合事实；末尾再次执行guard。工具/写事务原权限、修订、令牌与确认校验不变。
- session-host.ts 保留执行协调和原恢复行为，调用上述边界；session-feedback、权威Schema及工具归一/合并机制直接复用，不新增纠错链。模型实例不在领域工具中创建。03再处理调度责任，08再补生命周期。
- 新增真实SDK回归在投影读取间注入修订变化，断言模型HTTP请求为0；增强原5→3加工规则纠正回归，直接解析后续SDK请求的当前事实，断言revision2、count3及有效说明。

## AC与证据

| 追加AC | 实际证据 |
| --- | --- |
| R02-A1 | 83项会话组包含真实SDK摘要/纠错/正文计量、unknown usage、供应方拒绝/流观察；新模型模块保留同一传输与准入机制。 |
| R02-A2 | 新混合修订负例先红后绿；同轮5→3纠正后实际模型输入断言；既有摘要后改数量、来源/权限及取消合同回归；补测真实在途暂停/查询/继续和纠错中暂停恢复。 |
| R02-A3 | 同一Schema/feedback路径，83项涵盖包装归一、遗漏有效字段、中文/截断及多交付组合；正式宿主调用集中模型和逐次事实构建接口，无平行状态机。 |

## 命令与结果

运行封装复用 ../r02-verification/run-directed.py，从隔离开发容器读取连接但不输出秘密。原始日志保存本目录，不把不同轮次的重叠测试数相加。

| 检查 | 结果 / 日志 |
| --- | --- |
| vitest run tests/integration/rebuild-session.test.ts -t 'R02-A aborts'（旧代码） | 1失败、82跳过；旧实现错误地发送并成功结束，没有中止混合上下文。red.log |
| vitest run tests/integration/rebuild-session.test.ts | 83通过，42.05秒；green.log |
| 上述文件与rebuild-execution.test.ts，筛选 R02-A aborts / refreshes dependent rules / pauses a real in-flight / preserves correction intent / accounts a timed-out / recovers accepted work once | 6通过、164按筛选跳过，16.98秒；combinations.log。包含最后新增的下一次SDK事实断言。 |
| typescript --noEmit | 通过；types.log |
| eslint（3个受影响源码文件及集成测试） | 最终通过；lint.log。初次发现移出上下文后遗留未使用TurnProof，已移除。 |
| git diff --check / cached --check | 通过。 |
| docs:check及变更Markdown链接/锚点/表格/围栏、10票状态/依赖核对 | 通过；3份Markdown、52处相对链接，状态与依赖无不一致。 |

## 针对性复审与保留

Standards与Spec独立只读复审实际未提交差异（基线11a9e9f），未发现可行动P0/P1或其他待修问题。已知未使用导入在提交前移除且lint复验通过。本次没有再次发真实模型请求，也未重跑已通过C01/C02；上述测试是受结构变化影响的受控自动回归，不能据此声称真实模型成功率提高或零参数错误。

旧验收会话/数据、活动账本/关闭时间均未进入这些自建测试库的写入范围。无DDL、供应方/密钥设置修改、环境重建或远程推送。下一步按既有依赖完成REBUILD-03追加项。
