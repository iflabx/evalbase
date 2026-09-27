# Phase 1A-17：性能、非生产部署与真实 Owner 闭环

Status: ready-for-agent
Implementation: not-started

Blocked by: [16](./16-observability-and-local-persistence.md)

## Outcome

在 Project Owner 已确认可经既有 Tailscale 路径访问的目标非生产服务器上部署 Web、Worker、PostgreSQL 和 MinIO，按已确认硬件/并发/冷热缓存口径验证容量与 P95；运行场景 A–F、H、I。最后由 Project Owner / Sole Developer 使用允许数据完成一次真实场景 A，并保留可审计证据。

本票开始时由 Agent 执行环境采集、部署、自动化和证据准备；需要真实 Owner 操作时把 Status 改为 `ready-for-human`。不得由 Agent 伪造人工闭环或 Production Gate 结果。

## Required reading

- [Implementation Spec](../spec.md)，重点为 Performance、real user acceptance 和 Status meaning
- [PRD](../../../docs/PRD-v2-test-data-management.md)，重点为 3.2、14.2、16、20
- [Decision record](../../../docs/reviews/phase1a-solo-owner-decision-record.md)
- [Architecture deployment/spike](../../../docs/architecture/phase1a-architecture.md#17-非生产范围production-gates-与实现前-spike)
- [Test plan](../../../docs/test-plan-phase1a.md)，重点为 A.5、G.1–G.4
- [Non-production Server Development Gate](../../../docs/reviews/phase1a-nonproduction-server-development-gate.md)
- [ADR-0001](../../../docs/adr/0001-phase1a-deployment-topology.md)

## Vertical slice

| Layer | Deliverable |
| --- | --- |
| Data | 目标环境/Fixture/result/evidence manifest；产品数据仍只使用允许分类的合成或明确非敏感材料 |
| Domain | 通过现有完整闭环验证所有核心不变量，不新增业务能力 |
| Public interface | Owner 本机浏览器 S-HTTP、完整 Worker/PG/MinIO、Package download 和离线 S-CLI；既有 Tailscale 路径不作为测试目标 |
| UI | 场景 A–F、H、I、loading/background 行为、非生产/无备份/未远端验证文案和键盘/焦点 |
| Tests | 目标服务器性能协议、服务器侧端口绑定、全套自动化 E2E、正常重部署和真实 Owner manual acceptance |

## Gap closure

关闭 TP-G04：记录 CPU 型号/vCPU、RAM、disk/type/filesystem、OS、container runtime、Node/PostgreSQL/MinIO/browser 版本、资源限制、volume 位置和客户端。若报告浏览器端到端延迟，可把网络路径延迟作为上下文记录，但不以其判定 Tailscale Gate。缺少必需环境项时不得把性能标为通过。

## Acceptance Criteria

1. 一台 Owner 已确认可经既有 Tailscale 路径访问的非生产服务器运行 EvalBase 专用 Compose project；只有 Web 的实际 `WEB_PORT`（默认值 `3000`）绑定 Owner 指定的服务器地址，Worker/PG/MinIO 无宿主机入站端口，且其他服务器项目不受影响。
2. 记录 Owner 对既有 Tailscale 访问路径的确认，以及 Web 的实际 `WEB_PORT`、指定绑定地址和服务器侧监听证据；不重复测试 Tailscale 连通性，不要求断开 Tailscale 或执行公网负向探测。访问路径、绑定地址或暴露面变化时重新评审。
3. 应用登录仍然必需；唯一真实用户使用 Owner，Editor/Viewer 只用于自动化或开发测试。
4. 记录完整目标硬件与软件条件；性能并发为一个模拟 Owner、一个浏览器会话、一个活跃数据 Job、无其他竞争负载。
5. cold 条件按重启 Web/Worker 记录，warm 条件先预热一次并至少 30 次，cold 至少 20 次；P95 使用 nearest-rank。
6. ready Data Asset 首屏 100 条预览 P95 ≤ 3 秒；10,000 条基础筛选 P95 ≤ 5 秒；10,000 条 materialization+publication P95 ≤ 2 分钟。
7. 按既定十进制口径测量 50,000,000-byte Data Asset、10,000 Source Record、5 assets/100,000,000 original bytes/10,000 records 和 100,000,000-byte `items.jsonl`；同时记录 RSS、CPU、object I/O、DB batch 和 cancel latency。
8. 超过 2 秒 UI 显示 loading，超过 10 秒转为可观察 background Job。
9. 若指标失败，先优化 streaming/batch/index/SQL/object write；不得增加 Arrow/Parquet、服务、容量或放宽 P95。未达标时本票不能完成。
10. 浏览器自动化场景 A–F、H、I 全部通过；场景 G 未运行且未显示为可用能力。
11. Project Owner / Sole Developer 通过正常 UI 完成一次场景 A：allowed CSV、filter、mapping、`gold_required`、`v1`、Standard Package、Validator exit `0`。
12. 人工闭环不直接修改 PostgreSQL、MinIO、后台状态或运行临时修复脚本。
13. 保留 app commit、环境记录、关键 object/job ID、Version/Manifest hash、Delivery/hash、Validator report 和 Audit refs。
14. 最终结论最多为“Phase 1A 非生产研发验收完成”；真实敏感数据和生产部署仍为 Not Approved，Production Gates 为 Not Evaluated。
15. 引用并复核前置 Server Development Gate 的环境与 Spike 证据，但用完整应用重新执行本票的最终性能、部署和真实 Owner 验收；不得把 Gate probe 结果冒充最终通过。

PRD trace: 48 项 Phase 1A P0 AC 的最终证据收口、场景 A–F/H/I 和 Phase 1A Definition of Done；AC-35 至 AC-37/场景 G 明确排除。

## Out of scope

- Production deployment、TLS/公网、第二真实用户、敏感数据、Backup/RPO/RTO/SLA、Langfuse API 和所有 Phase 1B。
- 以文档声明或本机测试替代目标服务器数据。

## Definition of Done

- TP-G04 环境记录完整，性能与部署验收有可复查原始结果。
- 全部 Phase 1A 自动化证据通过，真实 Owner 完成 G.1 并留下证据。
- 本票人工步骤由真实 Project Owner / Sole Developer 确认；没有伪造签字、评审人或专业背书。
- 报告明确区分非生产完成与 Production Gates。

## Comments
