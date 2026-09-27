# 测试集血缘源码复用登记表

> 更新日期：2026-09-02
> 适用范围：单人工作流原型 `v5` 与后续正式前端 Ticket。
> 本表区分“借鉴思路”和“复制源码”。未标为“直接复制”或“改写源码”的条目，均没有代码进入 EvalBase。

## 1. 当前登记

| 功能 | 当前状态与复用类别 | 固定来源 | 已检查的源码/资料 | 许可证 | 当前本地目标 | 后续直接复用条件 |
| --- | --- | --- | --- | --- | --- | --- |
| 原型视觉与通用控件 | 已改写内部 donor 的视觉基线 | 本仓库 `888cd7dd5d412a29b19fc692dedbae861033779c` | `frontend-v1/src/styles.css`、现有 UI primitives | 仓库内部 donor，按 [前端复制说明](../architecture/phase1a-frontend-reuse.md) 管理 | `docs/prototypes/THROWAWAY-phase1a-solo-workflow-ui.html` | 首个正式前端 Ticket 完整复制 `frontend-v1/` 到 `frontend-v2/`，逐文件登记实际改写 |
| 输入、活动、输出关系 | 仅模型参考；未复制代码 | OpenLineage `47b78f69cb11e280947e67b3a37c2bd80203bcb3`；Marquez `180f37b22387146187af1ef0279e3ee1d1ccd789` | OpenLineage `website/docs/spec/object-model.md`；Marquez `README.md` | Apache-2.0 | 原型本地事实生成器 | 不直接复制 event schema、服务端或 Web；如未来需要代码，先登记精确文件/符号及 NOTICE |
| 聚焦当前版本、只看直接关系 | 仅交互参考；未复制代码 | DataHub `05eac7c56e3ab3c111163dbac6a8998aab2127a2` | `datahub-web-react/src/app/lineageV3`、`metadata-models/.../UpstreamLineage.pdl` | Apache-2.0 | 原型的当前版本文字摘要 | 不预授权复制。其 React、GraphQL 与设计系统耦合较深；正式 Ticket 必须先选择最小可独立复用片段 |
| 关系详情与按需字段映射 | 仅交互参考；未复制代码 | OpenMetadata `ac760c8143f4380ded357c514ab38798b06fd47e` | `openmetadata-ui/src/main/resources/ui/src/components/Entity/EntityLineage`、`entityLineage.json` | Apache-2.0 | 原型资料行内的按需字段映射 | 不预授权复制。复制前必须核对 UI 依赖、精确文件与 Apache NOTICE |
| 图布局、节点选择与适应视图 | 候选，未安装、未复制、未依赖 | VGraph `e474815fbb683f2a4923d3148e26eb0bcd3fc8f8`；`@visactor/vgraph@0.1.0` | VGraph DAG、events、data-lineage 示例及数据结构说明 | MIT | 无；原型继续使用本地 HTML/CSS/JavaScript | 仅在正式前端出现确证的复杂图需求后，以独立 Ticket 评估；复制实质片段须保留 MIT 版权与许可声明，且图引擎只能接收展示 DTO |
| 类型模型旁证 | 仅研究参考；未复制代码 | Apache Atlas `df4d8248780a2d1d516400603166805fa645d7fb` | `addons/models/0000-Area0/0010-base_model.json` | Apache-2.0 | 无 | 不引入 Atlas 类型系统、服务或源码 |
| 输入快照产生输出快照 | 仅研究参考；未复制代码 | Pachyderm `e237475e9910a2d6299d7d2c3d6fc3b9a8f28f0b` | `README.md`、`console/frontend/src/views/DatumViewer` | Apache-2.0 | 无 | 不引入 Kubernetes、流水线或源码；`datum` 不得替代 EvalBase 测试用例 |

## 2. 本轮事实

- 本轮没有外部源代码、第三方 npm 包、图引擎、示例页面、图标或商标进入仓库。
- “来源与修改”页由现有 Throwaway HTML 的本地 JavaScript 和 `frontend-v1/` 风格令牌实现；顶部使用文字摘要，不使用关系图。
- OpenLineage/Marquez、DataHub、OpenMetadata 的贡献分别是模型、当前版本聚焦和按需字段映射思路，不是可声明为“照搬代码”的实现。
- VGraph 仍是受控候选；本轮不应在依赖锁文件、Compose、浏览器加载路径或正式产品代码中出现。

## 3. 后续正式 Ticket 的逐项核准

任何 Ticket 若要直接复制或小幅改写外部源码，开始实现前必须在本表新增或更新一行，并写清：

1. 上游仓库 URL、不可变 commit/tag/package 版本，以及精确源码文件和符号。
2. 复制类别：`直接复制`、`改写源码`、`仅交互/模型参考` 或 `候选未使用`。
3. EvalBase 目标文件、删改范围、所需上游依赖和最小验证场景。
4. 许可证兼容性、保留的版权/许可文本，以及 Apache-2.0 项目的 NOTICE 核对结果。
5. Project Owner 对该 Ticket 的单独确认。未完成该确认时，只能自行实现或保留为参考，不能复制源码。

源码复制完成后，Ticket 必须把该行状态改为事实描述，并在需要时把版权和许可证文本加入正式前端的第三方通知材料；不得把“参考了某项目”笼统写成“已复用其代码”。
