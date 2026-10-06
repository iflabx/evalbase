# 项目助手优化：实施与真实 200 条闭环证明

2026-10-06。范围与合同见 [Spec](spec.md)、[优化合同](../../docs/assistant-optimization.md)。本记录只证明隔离环境中的实施和实测，不代签 Owner checkpoint，不表示已合并、推送或正式部署。

## 1. 四项优化的实施结果

| 项目           | 已实施                                                                                            | 直接证据                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 可靠结果       | 按完整有效候选核对数量、分类配额及缺失；保留成功输出，只补缺失；失败不能通过查询旧结果伪装成功    | 缺失恢复、旧任务恢复、配额、失败回执及冻结范围的公开 HTTP/Worker 回归                 |
| 同会话连续任务 | 保存目标、固定来源、有效批次、背景、采用回执；七批合为一个成果资产，局部修正替代前批，不重复计数  | 同会话真实采用 200 条；来源页仍能定位七个实际运行；采用及发布均有服务端确认回执       |
| 背景与短请求   | PDF/MD/TXT 附件、可定位原文、持久要求与用户更正；明确范围自动解析，不要求输入对象 ID              | 本轮同会话上传 GB PDF，真实片段读取；短请求固定范围、文档隔离与处理请求冻结的公开回归 |
| 工作区         | 直接复用 frontend-v1 donor 组件，宽工作区及窄屏排列；对话、附件、真实进度、候选表、确认和成果入口 | 16 项受影响浏览器回归、桌面/窄屏截图、Computer Use 发布和下载                         |

真实发布后摘要仍显示“候选待审核”的收尾问题也已修复：只有当前任务修订的真实发布成功回执、无在途回合和待确认操作时，摘要才转为“已完成”。后续新任务不继承旧完成状态。

## 2. 实际成果身份

- 验收项目：`project_4e56ea4e11b349dfad89aba5d7de7e90`，没有另建项目或账号。
- 唯一使用的会话：`conversation_6677776a9a1a44c8bcb8a84a94266370`。原失败历史保留，没有通过重置数据库或另开会话清除失败。
- 背景：GB/T 45654-2025 PDF，31 物理页；会话附件 `background_c9d380d8369c4b38b7ca458d18409566`。
- 原资料：ChineseSafe `test.jsonl`；20,000 行原资料分成两个 10,000 行上传资产。本次固定抽取范围和后续处理来源可追溯到第一份资产，不能声称逐条使用了全部原资料。
- 新目标草稿：`collabdraft_3867415720cb10bf4f5085da00ddac6967b3c24534399ef07d211084d6338dd9`。
- 新测试集：**GB安全试用题200条**，`testset_6d8058cb3a78430d8bd8862553600146`。
- 实际发布版本：**v1**，`version_0d0c074480d346f49c3153f5ff9d4c65`。
- 页面路径：`/projects/project_4e56ea4e11b349dfad89aba5d7de7e90/test-sets/testset_6d8058cb3a78430d8bd8862553600146?version=version_0d0c074480d346f49c3153f5ff9d4c65`。
- 成果资产：`asset_b08fc08947fc449f78a2b2219a1b5273e`，名称 `任务成果-74b94a76.jsonl`。七批占一个成果资产，独立来源容量规则不变。

采用、草稿审核、发布确认和两个下载均通过 Computer Use 操作普通前端；全量只读 API 和本地文件解析补充核对，未直接写验收数据库。

## 3. 全量核对

| 指标              | 实际结果                                 | 范围与限制                                                                       |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| 总数              | 200                                      | 新 v1，非旧测试集复用                                                            |
| Metadata 类别     | 生成内容 100、应拒答 50、非拒答 50       | 对实际记录统计                                                                   |
| 生成内容风险编号  | 附录 A 的 31 个编号均存在，每个至少 3 条 | 标签覆盖，不能据此断言内容足够测试全部风险                                       |
| 问题/期望输出空值 | 均为 0                                   | 全 200 条                                                                        |
| 完全重复问题      | 0                                        | 精确文本去重，非语义相似度保证                                                   |
| 来源              | 200/200                                  | 指定成果资产和各自原始处理运行                                                   |
| CSV               | 200 条，全字段与最终记录逐条一致         | Metadata 为现有 CSV 合同的可读文本，不是 JSON 列                                 |
| ZIP               | `data.csv`、`provenance.csv`             | 压缩包校验正常；数据字节与独立 CSV 下载相同；溯源 200 行与当前记录和来源序号匹配 |

七个实际来源运行的记录数分别为 26、29、16、22、7、50、50：

| 运行                                          | 条数 |
| --------------------------------------------- | ---- |
| `processing_c024bf72e8ec46c4925e4ebe3e86d803` | 26   |
| `processing_74334c285c9a40628f49fc0ea9399db1` | 29   |
| `processing_16ff722a4ecc454687da7721fed1bc63` | 16   |
| `processing_dc9f09a0f9ec47de928c3cd159ea8699` | 22   |
| `processing_c7220ccb141a4f48a9c6e0ba80bfc79e` | 7    |
| `processing_fd219c5543e04d0e9413b763cc60c6cd` | 50   |
| `processing_c82259e3c1c74b1690c23cb8ae1e651a` | 50   |

导出 SHA-256：

- CSV：`0098a28789af14df02198813f6ec313c27584b2ad812ff73144526b4002e76331`。
- ZIP：`e6730d86cae51d52520fe58c1d4fc1bbd6f2d0da29a497ca2a2facc299eed8f8b`。

浏览器未回传 Blob ZIP 的完成事件，但实际文件已保存；因此使用实际文件、ZIP 校验和内容比对证明成功，不把工具超时当作下载失败或点击动作当作完成。

## 4. 内容复核与诚实限制

200 条模型候选采用后，操作人员通过普通草稿字段编辑修正了 **24 条**，刷新后及最终 CSV 中均保留。这不是完全自动的一次生成成功，也不是人工重写大部分题目。

修正位置：27、29、82、83、84、85、86、87、88、89、90、91、96、99、113、118、120、121、123、125、128、141、147、166。实际草稿行修订及字段作者可佐证。

主要修正包括：题目与风险编号/判分条件错配；知识错误；含糊的故事或虚构要求不适合作为明确应拒答题；一条重复题；非拒答题中的自相矛盾要求。对应规则和分类保留在 Metadata，期望输出为逐题验收条件。

剩余限制：

- 模型仍可能声称“已修正”却保留原题，或只改标签；服务端结构检查不能替代语义审核。
- 本次共 54 个已存回合，含自动续做、工程诊断与纠错。已实现短请求和同会话，但不宣称复杂 200 条任务只需一条提示或两三轮操作。
- 本成果是 **200 条试用样本**，不满足标准正式题库规模，也不证明完整标准合规。标签存在不等于实际内容覆盖，正式使用仍应由相关专业人员复核。
- 扫描 PDF 无可提取文字时明确失败；本轮没有新增 OCR、向量库、常驻知识库或跨会话文档记忆。
- 真实模型实测只使用当前配置的 Qwen；其他模型兼容性及大规模性能不由本轮证明。

## 5. 固定提交、审阅与验证

最终代码固定于 `65c10e9b683928765a9a8d7f3a3d3da6213b26fe`；核心实际生成、采用和发布时的代码为 `d58290fe5197468f9441bf704cf0d83598b8f602`。后续只补发布摘要一致性，不重新生成、采用或发布这个版本。

Standards / Spec 双向审阅及定向修复已经覆盖本轮受影响的权限、持久化、确认、回执、容量、失败恢复和 UI 合同。此前 67 项后台回归、16 项浏览器回归通过；后续按直接发现补定向检查，没有为每个小修复重复跑全仓库。

执行机日志保存在 `D:/AgentBench_v2/.scratch/assistant-optimization/`，关键证据：

- `missing-count-green.log`、`legacy-task-recovery-green.log`：缺失结果和旧运行恢复。
- `actual-batch-quotas-green.log`、`failed-tool-correct-action-green.log`、`saved-cross-receipt-green.log`：配额、真实执行和恢复回执。
- `background-private-run-green.log`、`background-affected-regression.log`：背景位置、容量、账号隔离及冻结。
- `assistant-final-browser-unique.log`、`assistant-final-front-types.log`、`assistant-final-frontend-build.log`：受影响浏览器、前端类型与正式构建。
- `conversation-cap-red.log` / `conversation-cap-green.log`：同会话 100 回合的统一上限；第 101 回合仍拒绝。
- `empty-adoption-red.log` / `empty-adoption-green.log`：空目标草稿修订和整任务采用，确认重放不追加。
- `published-task-status-red.log` / `published-task-status-green.log`：真实发布完成、回执恢复和下一任务不继承完成。
- `final-export-verification.json`：全量文件比对、数量、修正位置和来源运行统计。
- `GB安全试用题200条-v1.jpg`：实际新版本页面。

没有运行新的 5/10 人压测、两小时稳定性测试或生产重启。保留隔离验收环境供 Owner 使用；不触碰其他服务器项目，不合并 main、不推送 GitHub、不正式部署。

最后窄复审：Standards 与 Spec 均无明确 P0/P1/P2，发布状态的 3 项公开回归、类型与 lint 通过。Ticket Closure Review P0/P1 cleared at `65c10e9b683928765a9a8d7f3a3d3da6213b26fe`；证据范围为本 Spec 的上述受影响矩阵，未扩展为全仓库审计。后续进度文档提交不改变运行代码。

## 6. 查询与要求同步修复（2026-10-06）

本节是后续缺陷修复记录，不改写上节验收历史。代码固定于 `dc1f0a33d65b1c266b00686552d957e26fff08b0`，4217 隔离验收环境仅更新 web；健康检查返回该 SHA，PostgreSQL 与 MinIO 均正常。处理 worker、验收库与用户数据保持原状。

- 查询接近既有 8 步／12 工具上限时，预留最后一步只做真实结果汇总；未完成的执行义务、无回复或继续请求工具仍报告失败，不以查询回执冒充处理成功。
- 要求保存为完整替换快照，并去空白、重复。数量可明确撤销为 null；最终总数核对仍检查全部实际输出，不把新候选数量错当草稿总数。
- 真实 Qwen 最初仍照抄历史计划和旧清单；追加修复将上轮要求、原请求、最近更正分别呈现给模型，保留实际业务回执及重试依据。任务卡不再把旧原始请求当作当前要求显示，显式空要求也不回退旧目标。

Computer Use 在原会话 `conversation_a9556bf9b06a41f9b1ed9e1774e576f2` 验证：

- 原报错历史保留；继续风险核对后正常汇总。最终回合 `turn_8e212792b1734ce9a938161122099e71` 成功，8 个工具回执均成功，仅含计划和读取记录，无扩写、采用、发布或待确认操作。
- 用户短请求把随机抽取改为按风险类别选题；旧会话的累积清单经整理从 13 条缩为 5 条当前要求。回合 `turn_065a5af0bcb74b52b35eb439abb61271` 成功，后续继续查询仍维持这 5 条，保留 200 条、100/50/50、期望输出、Metadata 与优先保留原题的约束。
- 未另建项目、账号或测试集，既有已发布 200 条成果未重新生成或采用。

自动与审阅证据位于执行机 `D:/AgentBench_v2/.scratch/assistant-optimization/`：

- `assistant-findings-green.log`、`assistant-count-withdrawal-green.log`、`assistant-focused-final.log`：查询汇总、失败义务、要求替换及撤销数量的公开回归。
- `assistant-requirements-history-red.log` / `assistant-requirements-history-green.log`、`assistant-requirements-snapshot-red.log` / `assistant-requirements-snapshot-green.log`：历史计划不再重放，上轮要求与当前更正分开；最后 7 项相关回归通过。
- `assistant-history-confirmation.log`：包含创建候选的前置测试后，要求更正使旧确认失效及真实确认续做均通过；单独选择依赖共享候选的用例不能作为完整运行。
- `assistant-requirements-snapshot-type-green.log`、`assistant-requirements-checked-style.log`、`assistant-current-requirements-ui-type.log`、`assistant-current-requirements-ui-lint-green.log`、`assistant-requirements-current-ui-image-build.log`：前后端类型、lint、格式及正式镜像构建通过。
- `assistant-bugfix-real-green.json`：真实模型会话及当前要求的只读回验记录。Standards / Spec 窄复审均无未关闭 P0/P1/P2，包括显式空要求不回退原目标的修正。
- `assistant-bugfix-browser.png`：最终 4217 页面刷新后展开的 5 项当前要求，旧原始请求不再混入任务卡。

验证限制：较广回归中的既有故障注入用例“links a processing receipt before post-commit reporting, and durably stops its queued job”仍失败；在修复前 `89c79b15bad33215eb8ba76ee77439e91fbe868d` 上也复现，见 `assistant-postcommit-baseline.log`。本节不宣称全量回归全绿。未合并 main、推送 GitHub 或正式部署。
