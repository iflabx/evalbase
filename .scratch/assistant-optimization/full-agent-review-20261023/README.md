# 全链路审查离线证据

审查基线：3ff97f78acd75b4330e2c9bc9b42c5f4fe23836d；对应业务代码与2c74b8e一致。结论见[审查报告](../../../docs/assistant-full-review-2026-10-23.md)。

## 已执行范围

2026-10-23在本机源码快照上运行诊断探针，得到[7个观察结果](probe-results.json)，共4类机制差异。无网络调用、无数据库连接或写入、无旧预算变更。未运行应用回归、模型生成或Computer Use，不能把“缺口成功复现”记为业务验收通过。

探针执行源码中的反馈/增量合同/进展选择/纠错循环。替换依赖包括：不可达核对分支的防误调用stub、固定输入的canonical JSON、SDK/provider与Schema包装；AJV使用本地已安装依赖。第二次纠错探针使用拒绝结果的accept和不同无效输出，证明循环实际发送的上下文不更新，不证明真实模型一定两次给相同答案。增量Schema使用代表性基础属性检查preparePlanAmendment的分支，完整出站Schema仍需OPT-46公共入口回归。

## 复现方式

附件[probes.mjs](probes.mjs)与执行版本逻辑相同，仅将本机固定路径改为参数。参数分别为相同基线源码根、可解析本地AJV的package.json、输出文件。需支持stripTypeScriptTypes的Node 22；不安装新依赖、不连接应用。

    node probes.mjs <source-root> <local-package.json-with-ajv> <new-output.json>

原执行使用下载的源码快照和frontend-v1已有AJV。将来只在需要核验旧诊断时按本地快照运行；旧probe-results.json保持原始观察，不覆盖成修复后的结果。业务回归必须按票据通过公开入口实现，本脚本不是新的产品测试框架。

## 输入源码SHA-256

| 文件 | SHA-256 |
| --- | --- |
| src/assistant/feedback.ts | 070364deaea71c3ec84a5b71cae83fe5b628bb97a95e032c78e53d8ad128b871 |
| src/assistant/plan-request.ts | 59b15472381c47502bf71a8a4dd0026bbf082cce7e02bbafacdd0f5dc5d4e346 |
| src/assistant/delivery-plan.ts | 1bdf1c379062111b2c909f34366742426c3e9c67eb01a95a6265d10f56d3ae11 |
| src/assistant/recovery.ts | a31525b62f685b022cccba7e266724d11dd13a25faa39821ca72034d17d5228d |
| src/assistant/tool-repair.ts | 6e2c580c24dfe0a36b47f1d59270ee9213c942900acde96e8c50134e8168682b |

## 本轮文档保护

业务源码、现有验收数据和预算未修改；既有未提交的batch1-repair/semantic-results.json排除在本次文件清单。报告中未复现的部分提交/性能风险已单独标注；不把本轮审查当作运行环境安全或性能验证。

## 文档验证记录

- 文档链接：分批检查全部14份交付文件，446个本地文件链接可解析；31个新增链接中的章节锚点检查通过。
- 格式：修改的Markdown表格列数、代码围栏、UTF-8检查通过；probe-results.json可解析。
- 诊断脚本：node --check通过；本轮未再次执行它以更新或覆盖旧观察结果。
- 仓库检查：git diff --check通过；npm run docs:check通过。现有检查器报告38个生命周期行，不能单靠该数字声称新增46～50所有合同已通过，新增票据由上述内容/链接检查覆盖。
- 改动隔离：src、tests、frontend-v3及依赖清单无本轮差异；预先存在的batch1-repair/semantic-results.json内容SHA-256在文档写入前后均为c99545cc5a5af148cbc194935cf8973fff6260829435b9f717903f1db2f52a0c，未纳入本次提交。
- 只提交本次14份文档/离线审查附件，未部署、合并或推送。
