# OPT-47 实施与定向验证（2026-10-23）

## 基线与结论

- 工作目录：/home/bistu/EvalBase/.worktrees/agent-data-processing；分支 codex/assistant-optimization。
- 基线 f3b2d80ed0480070e7e19aa5c504dd255eff1030；代码提交 ca2e4b1f3072f8e31d9bbaf4a163e413af726c05。文档提交不改变运行代码身份。
- OPT-47 Implementation completed / Validation targeted-pass / Owner pending。共 **247 项不同用例通过**，按文件和完整用例名去重，不累加重复运行次数。[机器清单与各用例采用的最终证据](opt47-development-20261023/summary.json)。
- 未运行真实模型或 Computer Use，未更新4217、合并main、推送或打tag。4217最近部署记录仍2c74b8e；第10项真实模型验收留给OPT-50，不以受控回归代签。

## 责任与调用方

| 改动 | 实际调用方与退出路径 |
| --- | --- |
| source-discovery | query_project各兼容kind共用有界目录；优先明确页面/已确认对象；名字变化可在两次读取内切换到真实来源。无名称时聚合文件和可写草稿，最多5项，权限/存活复检；缓存不跨kind重开额度，澄清持久化后直接结束，不再追加模型总结 |
| processing-preparation / prepareBusinessProposal | 普通工具、SDK参数纠错、业务纠错、补参数、保存步骤派发和恢复共用PreparationResult；整份问题列表保留tool/operation/path/keyword/code/message；未来步骤可暂缺尚未创建的引用，执行时必须绑定真实对象 |
| 范围编译 | 只将明确、肯定且绑定当前来源的全部要求编译为真实ID和hash；已有局部范围、预览和字段中的“全部”不能扩成整份。复用选择保留原hash，修订变动进入澄清；原事务仍复检权限、容量、hash和租约 |
| 清洗及字段 | 默认问题首尾空白、空值/重复检查，不删除；期望输出和Metadata保护。额外语义指令使用用户真实要求，不接受模型自拟内容；否定字段指令不作为授权。未知信息由既有澄清/有界纠错处理 |
| 选择与精修 | 读取、预览、提交、候选选取共用选择校验和真实算法；明确false和互斥模式保持；Metadata按实际子键匹配，精修复用同一trim/大小写规则。随机seed实际传入选择器并持久化，默认重读复用旧seed/IDs，重新抽取需明确授权；全部选取不产生null随机seed |
| 草稿/保存位置/错误投影 | 新建、继承、同名复用、query.kind与target.kind的条件字段在副作用前验证；复用不忽略不同用途。生成保留合法outputCount；全量容量、空白及重复键/场景按真实操作报告 |
| 部分提交 | generate_candidates先预检，保留要求保存戳、原命令键与draft_creation_receipt；no-effect错误码不能覆盖已提交要求/目标。旧失败行按实际回执识别部分提交，恢复复用同一目标/运行；响应丢失先对账，不补偿删除、不新建空草稿 |
| 续接进展 | 目录排序、分页、计数变化作为只读事实，不作为新业务完成回执；预算控制器、原共享两次修复上限及旧冻结配方保持 |

没有新增公开API、数据表、依赖或前端页面；frontend-v1视觉合同不变。读取/编译可以提前发现问题，最终业务事务校验仍保留。旧数据、历史失败、字段保护及固定确认参数不迁移。

## 定向证据与复现

[固定配置](opt47-development-20261023/focused-vitest.config.ts)只收集明确列出的当前测试，避免历史源码副本。运行器[run-check.py](opt47-development-20261023/run-check.py)只读取现有evalbase-agent-test两项服务配置，校验Compose项目；数据库由测试夹具逐项新建UUID名称并清理，使用专用opt47-contract-regressions-20261023桶。凭据只在进程环境传递，不写报告。

核心回放命令（从上述工作目录执行，需既有隔离测试服务）：

```bash
python3 .scratch/assistant-optimization/opt47-development-20261023/run-check.py replay.log node_modules/.bin/vitest run --config .scratch/assistant-optimization/opt47-development-20261023/focused-vitest.config.ts tests/unit/assistant-processing-preparation.test.ts tests/integration/assistant-processing-preflight.test.ts
```

| AC/风险 | 已采用证据 |
| --- | --- |
| R47-1、2、10：发现、同名、无匹配、分页/新名、当前对象、失效与降权 | 公开消息/真实SQL目录/模型实际请求数；泛指固定澄清零副作用，新名称实际提交正确草稿，viewer不见草稿，缓存复检撤权，目录变化不增加完成事实 |
| R47-3～8：配置/范围/保护、普通补充与恢复 | 真实两条文件→共享预检→一次受理→真实清洗Worker输出；同时列出数量/键/范围问题，沿共享额度纠正→业务范围澄清→普通回复后实际受理；预览、局部选择、2→3和旧hash不扩大范围 |
| R47-9：部分与完整回执 | 配置失效、背景变化、容量失败均在目标提交后/运行前注入；去掉新effect标记的旧格式夹具仍沿原键恢复；断言一个目标、一个运行和同一ID。处理提交后丢响应先找回执，不再次提交 |
| R47-11～14：选择合同 | 缺conditions、未知单位、Metadata缺key/value、count/percent边界、互斥模式/false、顶层/内层/冲突seed；真实选择器验证ID集合与持久配置；精修条件与选择集合一致，默认重选不改变旧seed |
| R47-15、16：条件字段、归一与容量 | 新建/继承/复用及不同用途、query/target不适用字段，空白、重复键/场景、最终8000边界、生成数量；同一个修复字段不解除其他合法字段/目标模式的保护 |
| 相邻安全边界 | 复用并定向复检意图、暂停/停止、撤权、旧回执、方案核对/恢复、数据选择既有保护；详见机器清单，不把未跑旧验收任务计作通过 |

先保留contract-red的7条失败和收尾review-red的3条失败，再修复并验证；后续夹具初始化/顺序断言问题与业务缺陷分开。详细原始日志留在同一证据目录；机器清单为各不同用例选择最终有效结果。

静态检查：tsc --noEmit、针对12个代码/测试文件的ESLint、Prettier及git diff --check通过。最终文档集合另执行一次npm run docs:check；JSON清单已解析，无新增Mermaid或主流程图变更。

## Standards

一次收尾审阅发现3项P1：固定选择hash被重算、关键字“全部”被视作全量授权、任意语义关键字放行模型清洗要求。均已修复，新增相应反例/公开边界测试。后续仅复检修复及直接受影响路径，没有再次执行完整审阅。

## Spec

一次独立审阅发现3项：已有局部选择扩大整份来源（P1）、否定字段指令/自拟清洗内容被接受（P1）、省略seed重复抽取（P2）。均已修复并定向复检；与Standards重叠发现分别保留，不将审阅数量当成独立缺陷数量。两轴当前无未关闭P0/P1。

## 保留与限制

- 全程没有连接Owner验收数据库执行变更，没有重跑历史248/400条、CU第7/10项或重置额度。真实模型请求0；原环境不切换。
- 原未提交semantic-results.json的SHA-256仍为c99545cc5a5af148cbc194935cf8973fff6260829435b9f717903f1db2f52a0c，未写入或提交。
- 本票只闭合已约定处理合同；对不能确定的自然语言范围采用保守澄清。长历史/任务边界、分层累计预算、前端续接及集中真实模型验收仍分别属于OPT-48～50。内容质量继续人工审核。
