# Phase 1A 冻结原型 v5.2 与合同、Ticket、实现差异审计

| 项目 | 内容 |
| --- | --- |
| 审计日期 | 2026-09-08 |
| 审计性质 | 只读差异审计；不修改正式合同、Ticket、ADR 或产品代码 |
| 冻结基线 | `66ba66b` / `prototype/solo-workflow-v5.2` |
| 原型文件 | `docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html` |
| 范围 | 冻结原型、2026-09-08 的原型相关提交和文档、现行合同、Tickets 20–28 与 `frontend-v3` / 当前 HTTP 实现 |
| 结论 | `Blocked for new implementation`：先同步合同和创建纠偏 Ticket，后续实现才有唯一授权来源。 |

## 1. 审计规则

`prototype/solo-workflow-v5.2` 是新的完整用户可见上限和下限。原型中的每项交互必须进入正式产品；原型未提供的用户操作不得借由本次同步进入产品。

本记录不移动 `prototype/solo-workflow-v1` 或 `prototype/solo-workflow-v5`，不重写已完成 Tickets 20–28 的实现或 Owner 验收证据，也不把浏览器 Mock 当作服务端实现证据。旧的 [v5 差异审计](phase1a-frozen-prototype-v5-contract-ticket-delta-audit.md)保留为当时的历史决策依据；本记录只取代它作为后续合同同步的输入。

## 2. 本次纳入的原型资料

| 固定提交 / 文档 | 审计处置 |
| --- | --- |
| `9c26f08`，测试集版本记录筛选 | 已验收的用户交互，必须转写；不能只采用其中 Metadata 一项而漏掉同页的来源、问题与记录来源筛选。 |
| `6ba640f`，[Langfuse Filters 调研](../research/langfuse-filters-pattern.md) | 仅研究证据。它提出的 URL 持久化、跨页筛选扩展、动态条件与完整 builder 均未被原型采用，不得写入合同或 Ticket。 |
| `e11e3e7`，统一下拉控件 | 已验收的视觉状态。它不需要新 API；正式前端必须在受影响页面复用 donor 风格，而不是引入新的选择框架。 |
| `d40b830`，行高 | 已验收：原始文件统一记录、数据集“全部记录”和测试集版本记录均有紧凑、适中、展开三档；只保留在当前浏览器会话。 |
| `66ba66b`，结构化 Metadata | 已验收：多个键和值可辨认地显示、展开、编辑和筛选；不等同于 Schema 或 JSON 编辑器。 |
| [v5.1 上传补充](../prototypes/phase1a-solo-workflow-v5.1-upload-amendment.md) | 已进入现行上传合同和 Ticket 28；仍需随全局基线改为 v5.2。 |
| [v5.2 记录浏览补充](../prototypes/phase1a-solo-workflow-v5.2-record-browsing-amendment.md) | 已冻结，但其正文只列出 Metadata 条件，未完整记录实际原型已验收的其他测试集记录筛选条件。合同同步前应补齐这份原型记录的事实描述，不改变原型行为。 |

## 3. 差异矩阵

| ID | 冻结原型事实 | 合同 / Ticket / 实现现状 | 判定 | 最小处置 |
| --- | --- | --- | --- | --- |
| D52-01 | 所有后续实现以 `66ba66b` / `prototype/solo-workflow-v5.2` 为用户合同。 | `AGENTS.md`、README、PRD、CONTEXT、Architecture、Frontend Reuse、Spec、Test Plan、系统流程、Owner 决策记录、API gap audit 与进度表仍普遍指向 `92b0113` / v5。 | P1 文档冲突 | 统一改为 v5.2；历史 v5 审计、历史 Ticket Comments 和旧标签只标明其历史性质，不改写。 |
| D52-02 | v5.1 支持连续选择追加、同项目原始字节 SHA-256 去重、混合批次只跳过重复项。 | PRD FR-03、Spec、Frontend Reuse、Test Plan Fixture 与 Ticket 28 已覆盖；`ce5c27b` 有实现和 Owner 验收证据。PRD FR-03 有两个编号为“8”的条目，DoD 和进度表仍把当前序列写成 20–27。 | 已实现；P2 文档陈旧 | 保留 Ticket 28 历史证据，修正编号、基线和当前 Ticket 序列说明；不重做上传实现。 |
| D52-03 | 测试集版本记录可筛选：一个或多个来源文件、问题是否填写、原始资料/手工新增、指定或全部 Metadata 字段的“包含”值。不同条件以 AND 合并；多选来源文件在来源维度内匹配任一项。已应用条件可单项移除或清除全部。 | 正式 PRD/Spec/Test Plan 未定义此公开行为。`frontend-v3` 只有来源与修改页的变化类型筛选；版本记录表没有筛选。当前版本详情 API 返回整版记录，未提供这套分页筛选查询。 | P1 合同和实现缺失 | 只为测试集版本记录增加固定白名单筛选，不引入任意查询、OR 组、保存筛选器、URL/session 持久化或 Langfuse builder。 |
| D52-04 | Metadata 保留多个“字段：值”边界：列表显示前两项及“+N 项”，详情显示完整键值；测试集编辑用键值对话框，重复键阻止保存。 | 现行 Mapping 虽可选择多个 Metadata 源字段，但 `src/server/app.ts` 的 `mapDisplayRecord` 将值以换行拼接；当前 API DTO、React 类型、测试集编辑、版本记录与来源详情均使用 `metadata: string`。历史 `case_revision.metadata` 还常以 `{ text: string }` 保存。 | P1 合同和实现缺失 | 将当前产品的 Metadata 明确定义为有序、字符串键值项，映射保留来源字段名；定义旧 `{ text }` 值的无损读取策略。不要增加 Metadata Schema、类型系统、JSON 编辑器、批量编辑或自定义查询语言。 |
| D52-05 | 三处记录表均提供会话内“紧凑 / 适中 / 展开”行高；所有下拉框采用已验收的 donor 风格。 | 正式合同、Tickets 和 Test Plan 无行高状态。`frontend-v3` 无行高控件；各页已使用 donor Select，但没有 v5.2 的完整视觉/状态对照。 | P1 行高缺失；P2 视觉记录缺失 | 行高作为前端局部状态实现，不加 API、数据库或偏好保存。每张纠偏 Ticket 写受影响下拉框和行高的原型对照并由 Owner 浏览器检查。 |
| D52-06 | 单文件、数据集全部记录和测试集版本记录均显示序号；点序号打开完整记录。单文件“查看原始内容”在当前页面只读浏览并能返回统一记录。 | Ticket 27 的逐页对照已经承诺编号打开详情，但当前数据集 DTO 不返回 asset/ordinal，两个数据集记录表不显示序号或详情；单文件“查看原始内容”是新标签页下载链接。版本记录也无序号或详情。 | P1 已有合同与实现不一致 | 新增窄记录详情读取，并使原始内容成为页面内只读浏览。为大型原始文件明确只读浏览的安全界限和截断提示，不能默认把 50,000,000 bytes 全部重新缓冲到浏览器。 |
| D52-07 | 记录列表均可搜索、分页并在当前页操作；测试集版本筛选的结果和页码随条件变化。 | 数据集统一记录已有查询分页；版本详情一次读取全部成员，`frontend-v3` 直接渲染 `data.records`，最多可达 10,000 条，没有版本记录搜索或分页。 | P1 扩展性和交互缺失 | 将版本摘要/图与版本记录分页分离为最薄的任务型读取；筛选、搜索和分页由服务端白名单处理。不能以客户端加载全部记录后再筛选来伪造该行为。 |
| D52-08 | 新功能必须沿 Owner 的使用逻辑逐票可见、可验收。 | Tickets 20–28 已完成并记录 Owner checkpoint；没有承载 v5.2 或 D52-06 纠偏的新 Ticket。进度表仍称 20–27 为当前序列。 | P1 交付计划缺失 | 新增后续 Ticket，不重开或改写已验收 Ticket。建议按“先原始文件与记录浏览、再测试集版本”拆分，见第 5 节。 |

## 4. ADR 与研究边界

ADR-0001、0003、0005、0007、0009 的存储、原子发布、版本、下载和上传决定不因 v5.2 失效。ADR-0005、0006 中“冻结 v5”的上下文文字应在合同同步时更新为 v5.2，但不改变其技术决定。

结构化 Metadata 会改变长期保存和旧记录读取方式，属于可逆成本较高的数据表示决定。合同同步应新增一份 ADR，至少固定：键的来源和允许范围、有序键值项的序列化、旧单文本 Metadata 的显示/导出兼容，以及版本/来源事实如何保持不变。

Langfuse 调研只贡献“固定字段、白名单、明确 AND 语义、可移除筛选标签”的交互原则。以下均保持禁止：Langfuse 源码复制、通用筛选框架、任意 Metadata 路径、嵌套 AND/OR、保存筛选、URL 或 session 恢复、动态列、ClickHouse 和新服务。

## 5. 建议的后续 Ticket 边界

以下是审计建议，尚未创建 Ticket，也不授权实现：

1. **Ticket 29：结构化 Metadata 与原始记录浏览纠偏。** 上传映射保留 Metadata 字段和值；数据集全部记录和单文件记录提供序号、详情、结构化 Metadata 展开及会话行高；单文件原始内容在页内只读浏览。其必要证据为一个多 Metadata 字段上传/浏览正常路径、一个旧单文本 Metadata 无损可读或边界路径，以及受影响 API/前端的静态检查。
2. **Ticket 30：测试集版本记录浏览、编辑与固定筛选。** 使用 Ticket 29 的结构化值完成 `v1`/派生编辑、版本记录详情、服务器分页搜索、固定 AND 筛选、筛选标签、会话行高和来源/下载一致性。其必要证据为一个创建或派生后筛选的正常路径、一个重复 Metadata 键或跨条件不匹配的边界路径，以及受影响 API/前端的静态检查。

每张 Ticket 的视觉对照必须以 v5.2 实际 HTML 和 `frontend-v1/` donor 为准。它们不加入登录、成员、权限、归档、记录删除、任意 Metadata Schema、版本合并、评测或任何原型外功能。

## 6. 合同同步顺序

1. Project Owner 确认本审计的范围、D52-06 的原始内容浏览边界，以及结构化 Metadata 的兼容策略。
2. 更新 PRD、CONTEXT、Architecture、Frontend Reuse、Spec、Test Plan、系统流程、AGENTS、README、决策记录和进度表至 v5.2；更新相关 ADR 的基线上下文，并新增结构化 Metadata ADR。
3. 补充 v5.2 原型记录中遗漏的筛选事实，保留 Langfuse 调研为非合同证据。
4. 创建 Tickets 29–30，明确它们依赖顺序、公开 seam、必要测试和 Owner checkpoint；历史 Tickets 20–28 不回写为未完成。
5. 完成合同链接、术语、状态与原型对照检查后，才由 Project Owner 分别授权 Ticket 29 和 Ticket 30。

## 7. 审计结论

当前产品可继续作为已验收的 Ticket 28 状态运行，但不得声称已达到 v5.2。下一步不是直接修改前端，而是完成上述合同和 Ticket 同步；同步完成后，Ticket 29 才是第一个可授权的实现入口。
