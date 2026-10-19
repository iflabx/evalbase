# OPT-38 实施与验证

日期：2026-10-19。Implementation in-progress；Owner pending。范围和完成标准以[OPT-38](issues/38-background-retrieval-and-planning-recovery.md)为准，不替代OPT-31内容质量与八类交付验收。

## 固定条件与改动

- 开发基线`077157659cb919d99e3c3536ca07ed68efe4e44e`（以最终记录校准），分支`codex/assistant-optimization`；原4217 Web `6ccbf913adc47cb04b4c5a08febcbe67f554efc7`。模型仍为`qwen-new`，配置revision 2。
- 当前查询/片段的可信定义优先；原文最多3片段、定义最多20条/6000 bytes不变。真实章节目录最多40条/6000 bytes，独立directoryFrom/sectionDirectoryNextFrom续读；未读目录不算生成依据。排除行政起草说明，保留普通冒号定义。
- 规划默认只读浏览；显式useForProcessing:false不选用。保存方案按实际已读且哈希/提取器版本一致的定义绑定；无可证明定位时保留真实已读文档，超12段明确停止并引导聚焦，不静默截取。保留其他文档约束；已有合法方案的必要定义不能被替换成前言。
- 普通重试及澄清绑定当前会话、文档集合、修订、证据和原规划请求，补充要求不被旧检查点覆盖。描述“拒绝执行/开始执行前…”不授权生成；仅完整明确的执行命令才能结束仅规划。已删无关旧附件不阻断当前任务，所需文档变化仍重核。
- 沿用AI SDK、业务工具、任务及预算，不增加外层循环、依赖、公开API或数据表；无需前端组件修改，保留frontend-v1样式。

## 定向自动验证

隔离test PostgreSQL/MinIO运行，不向Owner验收库写入夹具。真实GB的26个实际提取片段固定为tests/fixtures/opt38-background-fragments.json；非GB使用小型客服规范和70标题长目录。

- 初始红：目标章节定义被旧目录挤出、目录不可用已复现，早期试验及失败日志保留，未删除。
- `.scratch/assistant-optimization/opt38-review-fixes.log`：18项集成通过，包含完整未命中→满依据→错误引用→澄清→普通重试链、三种普通重试、停止/变更、旧检查点、输出合同和晚到响应。63项受影响单元通过，1项既有跳过；TypeScript与定向ESLint通过。
- 最后授权描述边界及附加文档约束补修：opt38-authority-final.log 6项通过；opt38-execution-description.log 新增“开始执行前必须拒绝”用例通过，均断言规划模式及零草稿/运行副作用。TypeScript及定向ESLint通过。
- Standards/Spec独立审阅仅核定变更范围；已修复初审发现的P1，最终named findings定向复审无剩余P0/P1。

## 环境与Computer Use

待固定提交Web-only构建和同一4217切换；切换前校验空闲、备份、10表计数及草稿内容摘要，保留PG/MinIO/两个Worker容器。

待在两个新会话以普通提示验证：同一GB原短提示；非GB“买错了想退钱”近义问法。均仅规划5条、不生成；记录实际会话、模型调用/纠错、耗时及全部失败，不使用技术提示或人工方案。


## 首轮真实复测及补修（全部记录保留）

固定Web `e2f0a3699fdd0687240d376508e66d416c7ba505`，Computer Use在现有项目以管理员新建两会话并上传文件，未调用业务写入接口或改库造方案。

- GB会话`conversation_4db3ac9d797d40afb90d10da2bbc8959`，文档SHA256 `dcaed877c417f57f339a0a50de62a623d810cb2328adea08482b36d157ca361a`。原提示完整使用票中问法。第一回合54.3秒/6模型请求/4工具，错误文档引用自动纠正，但deliveries对象类型纠错耗尽而失败；只发“请你重试”，第二回合21.9秒/5请求/5工具，仍有固定期望输出和要求保护校验失败，最终保存5条A.2.b、plan模式3步骤、question空，未生成。
- 首轮GB不能签通过：虽恢复保存，requirements仍残留被拒绝的“期望输出固定为A.2.b，作为该测试集的分类标签”，与Metadata分类矛盾。已定位为既有assertDeliveryRepair对独立标签说明匹配过窄且未禁止保留原句，非文档读取丢失。最小补修只对服务端明确拒绝且类别/定义/配额完整迁移到Metadata的模型提案生效；错误独立说明须同步迁移，标点/空格变体同样拒绝；复合业务约束及用户明确固定标签不放宽。
- 客服会话`conversation_dbbe8fa8eb704baf96457ff306649d7a`，提示“买错了想退钱这类，按附件做5条测试数据，先给方案，不执行。” 首次提交因同账号GB任务占用被服务端拒绝，页面输入保留；待GB结束后点击重新提交。已保存5条plan模式3步骤，Metadata类别退货退款，限定买错商品，逐题期望行为及隐私要求保留。此占用拦截不是模型成功回合，单独记录。
- 补修红测：opt38-output-directive-red.log明确复现。16项交付合同单元通过；真实调用入口的rejected-output集成新增“枚举拒绝→迁移但旧说明去句号仍拒绝→保留其他约束并成功保存”链通过；相邻OPT34/OPT38完整链通过。最终标点变体和静态检查结果待归档。
- 同一最终代码的新会话复测待完成。首轮失败没有删除、重置额度或修改历史会话。


## 等义字段定位补修

第二轮Web `e08b66f8a659e751958ec6837c4c00e691c3c660`，新GB会话`conversation_5781bc5fe30f4491a311d7156b36a45e`使用同一原短提示；首次因“全部标记为A.2.b”改为“全部在Metadata的riskCategory中标记为A.2.b”被逐字要求保护误拦，assistant_no_progress。只发“请你重试”后保存正确5条plan/3步骤，未生成，旧错误固定输出说明已不存在。仍如实保留首回合失败。

最小补修：仅服务端明确拒绝expectedOutput枚举、且结构化分类完整迁移到已验证的Metadata key时，要求比较可剥离该真实key准确的字段定位短语；其余正文仍逐字相同，不折叠大小写、引号或空白。17项交付合同单元（含路径/大小写/空白/引号负例）及真实入口rejected-output完整链通过，TypeScript/ESLint通过。独立Standards/Spec对该增量定向复审无剩余P0/P1。最终固定代码与新会话实测待下方归档。
