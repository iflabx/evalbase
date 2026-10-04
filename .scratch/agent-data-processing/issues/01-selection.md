# SEL-01 固定筛选与选取

Status: ready-for-agent
Implementation: ready-for-owner-checkpoint
Blocked by: none

## 范围与合同

[Spec](../spec.md)、[PRD SEL-01](../../../docs/PRD-data-selection-and-assistant.md#3-sel-01-筛选与选取)、[架构](../../../docs/architecture/data-selection-and-assistant.md)、[测试 SEL-1–6/UI-1](../../../docs/test-plan-data-selection-and-assistant.md)。完整保留 [当前原型](../../../docs/prototypes/data-selection-vnext.md) 的正式可用交互；无模型抽样。

## 路由和测试 seam

- reused：草稿读取、字段保存、来源文件、记录详情、发布与正式来源。
- added：草稿固定预览创建/分页/确认接口、版本选取规则读取。
- narrowed/retired：旧 source-selection 添加查询路径在正式前端切换后按实际调用盘点处理；不得先破坏删除/既有测试调用。
- 首个红测在纯选择公开函数检查可见字段规则和确定抽样；随后 HTTP + 真数据库测试固定身份、权限、revision、幂等、容量和发布历史。

## UI parity

| 页面 | 控件与顺序 | 状态与交互 |
| --- | --- | --- |
| 添加资料 | 来源文件 → 条件 → 全部/随机、数量/比例、种子 → 更新预览 | 5 文件提示；改参数立即失效，输入不丢焦点 |
| 预览 | 计数/确认在上 → 已选/全部候选 → 搜索/表格 → 20条分页 | 固定身份、排除/补选、恢复/换种子、整行及键盘详情 |
| 来源与修改 | 既有摘要卡保持 → 折叠选取规则 | 仅已接受规则；父版本、来源、计数真实 |

## 完成要求

SEL-1–6、UI-1 的相关部分有证据，类型/lint/构建通过，Standards/Spec 无 P0/P1。实现留在功能分支，继续 AI-02，不启动独立人工验收。

## Comments

- 2026-10-04：原型与现有 source-selection 差异已核对；当前接口提交时重查，需增加固定预览合同。尚未实现。

- 2026-10-04：本轮功能及对应自动化和独立复审已完成；真实浏览器问题已修复。统一证据见 [验证与交接](../verification.md)。三张 Ticket 共用一个最终隔离 checkpoint；Owner 人工验收 pending，不合并或推送。
