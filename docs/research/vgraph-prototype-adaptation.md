# VGraph 对 EvalBase 原型的可借鉴性调研

> 调研日期：2026-09-02<br>
> 范围：仅评估冻结后原型的测试集版本关系界面，不构成正式产品依赖或技术选型。
> 检查基线：仓库 `e474815fbb683f2a4923d3148e26eb0bcd3fc8f8`；npm 正式版本 `0.1.0`。

## 1. 项目识别

本文所称 VGraph 是 [VisActor/VGraph](https://github.com/VisActor/VGraph)。其官方说明将它定义为面向关系图、树、DAG、脑图和流程图的图可视化与分析引擎，并提供核心包、React 封装和 React UI 组件。[官方中文 README](https://github.com/VisActor/VGraph/blob/develop/README.zh-CN.md)

需要排除两个主要同名项目：

- [sunfanyunn/vGraph](https://github.com/sunfanyunn/vGraph) 是 NeurIPS 2019 图机器学习论文的实现；
- [bioinformed/vgraph](https://github.com/bioinformed/vgraph) 是比较基因变异的命令行程序和 Python 库。

两者都不适合 EvalBase 的测试集版本关系界面。

## 2. 当前原型已经具备的基础

当前[单人工作流原型](../prototypes/THROWAWAY-phase1a-solo-workflow-ui.html)已经以 `parentVersion` 保存父子关系，并用横向树展示主线与分支。版本节点可点击，点击后会切换对应版本的摘要、记录、溯源和下载；节点还区分正在查看、最新发布、默认版本和内容已删除等状态。

因此，VGraph 对当前原型的价值主要是改善版本图的阅读与导航，不是替换现有版本规则、分支命名、删除规则或数据溯源。

## 3. 建议借鉴到原型的部分

| 借鉴点 | 原型中的具体做法 | 采用理由 | 来源 |
| --- | --- | --- | --- |
| 横向层级排列 | 保持父版本在左、派生版本在右；同一代版本对齐，并尽量减少连线交叉 | 当前合同是每个版本最多一个父版本且不支持合并的分支树；可借用 DAG 的左到右层级布局，但不能因此加入多父节点或合并语义 | [DAG 布局说明](https://github.com/VisActor/VGraph/blob/develop/docs/assets/guide/zh/layout-spec/dag.md) |
| 祖先路径高亮 | 点击并查看版本时，高亮从 `v1` 到该版本的节点和连线，其余关系降低对比度 | 用户可立即看懂当前版本从哪里派生，不必逐个阅读父版本文字 | [数据血缘图示例](https://github.com/VisActor/VGraph/blob/develop/docs/assets/demo/zh/solutions/dataLineage.md) |
| 明确选择状态 | 继续让点击节点切换正在查看的版本，并使选中节点与“最新发布”保持两种独立视觉状态 | VGraph 提供节点事件和选择状态；原型已有相同行为，只需强化表达 | [事件说明](https://github.com/VisActor/VGraph/blob/develop/docs/assets/guide/zh/events.md)、[React 选择示例](https://github.com/VisActor/VGraph/blob/develop/docs/assets/demo/zh/reactNodes/useSelections.md) |
| 简洁节点信息 | 节点只保留版本号、创建时间、记录数和必要状态；用途、来源和变更仍显示在节点外的当前版本摘要 | 防止分支增多后节点尺寸失控，也避免把版本图变成信息卡片墙 | [字段关系 DAG 示例](https://github.com/VisActor/VGraph/blob/develop/docs/assets/demo/en/dag/columnView.md) |
| 适应视图 | 仅当版本图横向溢出时，增加“适应视图”按钮；保留横向滚动作为基础操作 | VGraph 的 `fitView`、平移和缩放适合大图，但当前小图不需要常驻复杂工具栏 | [缩放联动示例](https://github.com/VisActor/VGraph/blob/develop/docs/assets/demo/zh/react/zoomslider.md) |
| 方向清楚的连线 | 父版本到子版本的连线增加轻量方向提示，选中路径使用强调色 | 当前原型的普通线条只表示连接，方向主要依赖节点位置；方向提示能减少误读 | [DAG 水平示例](https://github.com/VisActor/VGraph/blob/develop/docs/assets/demo/zh/dag/dataAnalysisH.md) |

原型采用横向层级稳定、祖先路径高亮、选中状态清晰、轻量方向提示，以及只在实际横向溢出时出现的适应视图。它们直接改善用户理解，且不增加新的产品概念。

## 4. 可以复制什么

VGraph 使用 [MIT License](https://github.com/VisActor/VGraph/blob/develop/LICENSE)，允许使用、复制和修改代码，但复制其源代码或示例的实质部分时，必须保留原版权声明和许可声明。其正式包声明的第三方运行时及 peer 依赖另见[第三方许可证清单](https://github.com/VisActor/VGraph/blob/develop/THIRD_PARTY_LICENSES.md)。

对当前原型的建议不是直接复制实现代码，而是仿照以下非产品特定的交互模式：

- 左到右的版本层级；
- 选中节点和祖先路径高亮；
- 图溢出后的适应视图；
- 节点保持精简、详情放在图外。

当前原型是一个可直接打开的单 HTML 文件，现有版本图规模也很小。`@visactor/vgraph@0.1.0` 的 npm 包解包后约 5.62 MB、996 个文件，UMD 压缩产物约 482 KB；为了这些有限行为引入完整图引擎或 React/UI 封装，会增加构建、依赖、授权记录和维护成本。[npm 包](https://www.npmjs.com/package/@visactor/vgraph/v/0.1.0)

VGraph 官方数据结构说明还明确指出，它会为了性能直接修改输入源数据。因此即使未来接入，也应从 EvalBase 的只读版本查询结果生成独立的图展示数据，不能把正式版本领域对象直接交给图引擎。[数据结构说明](https://github.com/VisActor/VGraph/blob/develop/docs/assets/guide/zh/data-structure.md)

若确需参考 VGraph 源码，应只移植完成具体交互所需的最小片段，并保留 MIT 声明；不得把 VGraph 的示例页面整体当作 EvalBase UI。

## 5. 当前不建议采用的部分

- **不直接依赖 `@visactor/vgraph`**：官方目前只有一个 [`v0.1.0` 正式发布](https://github.com/VisActor/VGraph/releases/tag/v0.1.0)，项目仍处于早期阶段；原型可用现有 HTML/CSS/JavaScript 验证交互。
- **不照搬 VGraph 的页面视觉**：它是图引擎和示例集合，不是 EvalBase 的视觉合同；原型视觉仍以不可修改的 `frontend-v1/` 为参照。
- **不引入图编辑器能力**：拖动节点、自由连线、添加节点、改变父子关系等操作会绕过 EvalBase 的“基于某版本创建新版本”流程。
- **不采用力导向布局**：版本关系具有稳定的时间和父子顺序，力导向布局会使节点位置漂移，反而更难比较。
- **暂不折叠版本分支**：隐藏历史版本可能让用户误以为版本不存在；当前规模下没有必要。
- **暂不增加缩略图**：缩略图适合大图导航；在少量版本时只会占用空间。[官方 Minimap 示例](https://github.com/VisActor/VGraph/blob/develop/packages/vgraph/examples/components/minimap.ts)
- **不采用框选、多选、分组、动画和流程编辑器**：这些能力与当前“选择一个版本并查看或派生”的单人流程无关。
- **不采用 VGraph 的数据血缘业务模型**：它的血缘示例可启发路径高亮，但 EvalBase 的记录来源与版本溯源仍以现有原型合同为准。

## 6. 结论

VGraph 最值得 EvalBase 原型借鉴的是“横向层级图 + 点击选中 + 祖先路径高亮 + 图溢出时适应视图”。这些设计能让版本来源和分支位置更直观。

当前不建议直接照搬 VGraph 代码或引入其依赖：原型已有可工作的轻量版本树，而 VGraph 仅发布至 `v0.1.0`。应先用现有 HTML/CSS/JavaScript 仿照关键交互；等正式 React 前端确实出现大量版本、复杂分支和性能问题时，再对固定版本的 `@visactor/vgraph` 做独立技术验证。

## 7. 原型实际采用边界

本次仅用原型既有 HTML、CSS 和 JavaScript 实现左到右树、点击选中、祖先路径高亮、方向提示和条件式适应视图。没有安装 `@visactor/vgraph`、复制 VGraph 源码或示例页面，也没有改变 `parentVersion`、版本命名、删除语义、下载、溯源或正式产品接口。
