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
