# 机制整理诊断依据（2026-10-21，只读证据；2026-10-22整理）

本记录为只读审查与内存条件复现，未修改业务代码、数据库或预算，未调用模型。基线为4217应用92492e7a7b2a4eab2abf635226bdd6895f01997a；业务项目为project_baa6d51efef1403dbf035a7110fdc4d9。

首批五项原始Computer Use结果见[原记录](first-five-retest-20261021.md)。本记录补充其根因，不把恢复成功改写成首次通过，不覆盖原记录。

| 发现 | 证据与位置 | 结论 |
| --- | --- | --- |
| 澄清提示被执行声明过滤覆盖 | 会话conversation_fc16b0779823439684959e0eb1878e8f，轮次turn_c06b96c1fd89472f8ac4613f92d83b7f；agent.ts的claimedExecution及executionFeedback，基线约266、6861行 | 已保存问题为缺背景；“已有原始资料进行扩充”触发正则后被替换为笼统未提交提示 |
| 改数量触发场景校验 | 会话conversation_3dceccdb60a7460dbca55e7a81d7b622，轮次turn_06b19fbc2cf0426da5f6d18f7a6c2070；agent.ts约5179行 | 用户2＋1数量被正确提议，但第一交付携带2个场景，触发minItems:3；新要求未保存，原3＋2保留 |
| 语义缺失进入无损纠错 | tool-repair.ts约23、246、314行 | required直接交上下文；minItems仍进入无损模型修复。增加场景会改变含义，保留2项又无法通过校验；当前只缩小steps范围，未缩小deliveries |
| 重试资格与执行时间不一致 | store.ts约135行、tasks.ts约472行、budget.ts约70行、agent.ts约5613/6207行 | 资格只检查deadline未过；执行要求至少预留10秒并参考上次请求耗时；同turn重试沿用原deadline |
| 失败后按钮能力未刷新 | frontend-v3/src/components/project-assistant.tsx约869行 | control失败catch只更新错误及处理查询，没有刷新conversation；能力可停留在旧值 |
| 首次诊断被后续尝试替换 | agent.ts约937行saveDiagnostics | observations按turnId过滤后替换，首轮与重试无法分别查明 |

## 无模型的最小复现

在当前部署镜像中使用实际导出的sameRepairMeaning、canResumeAssistantTurn、requestFitsDeadline及实际claimedExecution函数；Schema场景片段与当前minItems:3合同一致。脚本从stdin执行，无文件/数据库写入。

| 输入 | 实际观察 |
| --- | --- |
| 2个场景／补成3个场景 | 2项校验失败，3项通过；增加场景的sameRepairMeaning为false |
| 剩余5秒、已走7个模型步骤、失败轮次尚有尝试次数 | canResumeAssistantTurn为true，requestFitsDeadline为false |
| 真实上传提示含“已有原始资料进行扩充” | claimedExecution为true |

## 时间与不确定性

- 第4项保留的7次请求HTTP均为200、transportRetries为0；末两次响应头耗时约20.5秒、15.3秒。HTTP200不证明参数正确，也不能据此保证响应体完整。
- 第4项首次失败后的重试未增加模型请求；最新诊断约1.1秒即以insufficient_request_time停止，随后重试HTTP409。最初minItems错误有实际工具回执支持。
- 原Computer Use记录出现输出长度上限提示；该尝试的原始stepDiagnostics已被后续重试覆盖，现存资料不能还原每次截断的具体内容与顺序。
- 第3项turn_319994c5739c4e3ca9f358ab04e4556b在重试后为成功，原失败详细诊断已覆盖；相关Worker时间窗未找到独立错误详情。不能确定最初是JSON解析、空输出或其他协议失败。上传文档后恢复成功不证明最初格式错误由缺文档直接造成。

因此整改首先针对已复现的共享合同、恢复与提示问题，并补齐尝试级诊断。对未知首因保留未知，不编造缺失日志。
