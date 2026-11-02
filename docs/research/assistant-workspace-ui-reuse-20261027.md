# 项目助手桌面式工作区：开源界面复用调研

- 核查日期：2026-10-27。
- 范围：用户截图中的 ChatGPT 桌面 Codex 工作区，包括会话侧栏、消息与执行过程、输入框、右侧工作区。
- 代码基线：EvalBase `codex/assistant-rebuild`，`24b5c48`；实际前端为 `frontend-v3/`。本地 AgentBench_v2 文档仓库不作为当前业务实现的依据。
- 性质：研究证据与建议，不修改产品合同，不代表组件已经编译、联调或完成视觉验收。与[重建架构](../architecture/assistant-rebuild.md)、适配验证收口（内部记录，不随公开源码分发）配套阅读。

## 1. 结论

**可以大量复用开源界面代码，做出接近截图的布局和交互；未找到可直接搬入项目的官方桌面前端完整源码。**

建议以 **assistant-ui 的聊天组件和外部状态适配 + 项目现有 shadcn/Radix 侧栏与分栏组件** 为主；参考 LangChain Agent Chat UI 的工具/中断/成果展示，参考 LibreChat 的整页组织。后端继续采用已确定的 Deep Agents TypeScript + LangGraph，不为换界面再引入另一套智能体、账号、会话数据库或工作流。

这是基于源码与接入边界的选型判断，不是证明 assistant-ui 已在本项目通过兼容性或性能测试。相似外观仍需要调整布局、字体、间距、颜色和业务卡片，并非安装一个包即可与截图完全一致。

OpenAI 官方开源目录列出 Codex CLI、SDK、app-server 等；app-server 是供客户端连接的运行服务与协议，不能当成桌面 React 界面源码，也没有必要为了外观把 EvalBase 换成 Codex 运行时。[官方开源目录](https://learn.chatgpt.com/docs/open-source)、[app-server 文档](https://learn.chatgpt.com/docs/app-server)

## 2. 当前项目能保留什么

| 已有代码或状态 | 已核实事实 | 对复用的影响 |
| --- | --- | --- |
| [frontend-v3/package.json](../../frontend-v3/package.json) | React 19、Vite 8、Tailwind 4、Radix、TanStack Query/Router、react-resizable-panels | React 组件比 Svelte 或完整 Python 应用更适合；无需迁到 Next.js |
| [sidebar.tsx](../../frontend-v3/src/components/ui/sidebar.tsx)、[resizable.tsx](../../frontend-v3/src/components/ui/resizable.tsx) | 已有侧栏和可调整分栏 | 截图的左侧导航、右侧工作区已有基础组件，不需要从零写拖拽分栏 |
| [验证页](../../frontend-v3/src/routes/projects.$projectId.assistant-validation.tsx) | 当前最小适配页每 800ms 读取快照；消息主要是完整文本 | 当前页尚非完整流式聊天实现，不能仅靠 CSS 显示实时 token |
| [运行宿主](../../src/assistant-rebuild/host.ts) | ChatOpenAI 配置 streaming:false，主流程使用 agent.invoke | 要提供真实流式输出，需要接入运行时流事件并核对取消、计量和完成边界 |
| [验证路由](../../src/server/modules/assistant-rebuild.ts) | 已有认证、快照、消息、停止、继续、上传和固定确认入口 | 可作为后续界面适配的事实来源；不能用组件的通用 approve 直接绕过应用确认 |

以上只描述独立重建最小适配的现状，不把它等同于整个正式助手的实现或验收状态。旧业务成果、预算和会话保留合同继续有效。

## 3. 候选项目比较

| 候选 | 可复用内容 | 许可证/当前状态 | 结论 |
| --- | --- | --- | --- |
| assistant-ui | 消息、Markdown、输入框、附件、自动滚动、推理折叠、工具分组、会话列表 | MIT；当前 React 包声明兼容 React 18/19 | **首选聊天界面基础**，仍需绑定现有会话和业务状态 |
| shadcn/ui 当前 AI Elements 模式 | Reasoning、Tool、Plan、Prompt Input 等组件组合；已有 Sidebar/Resizable | MIT；提供 Radix 版本 | **现有侧栏与布局优先复用**；部分展示组件也可作为低耦合备选 |
| LangChain agent-chat-ui | 流消息、历史会话、工具调用、中断、Artifact 右侧视图 | MIT；Next.js 应用，面向 LangGraph Server | 选择性取用交互和展示代码；不是现有 Fastify 接口的直接替代 |
| LangChain deep-agents-ui | 任务/文件侧栏、会话列表、工具审批、工具调用卡 | MIT；核查时仓库已归档 | 仅作源码参考，不作为新工作区长期依赖 |
| LibreChat | 接近完整聊天产品的会话/项目侧栏、输入框、推理、产物面板 | 根许可 MIT；客户端/API manifest 的 ISC 元数据有差异 | 适合布局参考；完整移植耦合其内部状态、数据协议和后端 |
| Open WebUI | 会话侧栏、结构化输出、推理、工具、产物 | 当前自定义许可证含品牌限制；Svelte/FastAPI | 不适合直接嵌入现有 React 应用 |
| Chainlit | Step 执行折叠、消息输入、右侧元素面板 | Apache-2.0；React 客户端通常连接 Chainlit Python/Socket.IO 后端 | 参考执行过程的表达，不引入完整平台 |
| 旧 Vercel AI Elements | conversation/message/reasoning/tool/prompt-input/artifact 源码 | Apache-2.0；官方宣布 2026 年 11 月底弃用旧入口并迁到 shadcn/ui | 新项目优先看迁移后的模式；复制旧文件仍须保留旧许可 |

证据：[assistant-ui 许可](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/LICENSE)、[React package](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/react/package.json)；[shadcn 许可](https://github.com/shadcn-ui/ui/blob/8f04138777c1b6996e709993362a7b0a12888ecf/LICENSE.md)、[AI Elements 模式](https://ui.shadcn.com/docs/ai-elements)；[Agent Chat UI README](https://github.com/langchain-ai/agent-chat-ui/blob/7a503412aeeb4534a24b04bd97b618ee3871821e/README.md)、[许可](https://github.com/langchain-ai/agent-chat-ui/blob/7a503412aeeb4534a24b04bd97b618ee3871821e/LICENSE)；[Deep Agents UI 仓库归档状态](https://github.com/langchain-ai/deep-agents-ui)、[许可](https://github.com/langchain-ai/deep-agents-ui/blob/f6a4f34565b42688be06498031fc9351c152614e/LICENSE)；[LibreChat 许可](https://github.com/LibreChat-AI/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/LICENSE)、[客户端](https://github.com/LibreChat-AI/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/client/package.json)；[Open WebUI 许可](https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/LICENSE)、[package](https://github.com/open-webui/open-webui/blob/33c1978d5bad52a31df75ea55143025dfad18d16/package.json)；[Chainlit 许可](https://github.com/Chainlit/chainlit/blob/190ea74239d9e84b26e7c91bc2882dd038942564/LICENSE)、[React client 文档](https://docs.chainlit.io/deploy/react/overview)；[旧 AI Elements 许可](https://github.com/vercel/ai-elements/blob/ca8be600bfd01b3131f9bf6134b51602a71f4374/LICENSE)、[弃用公告源码](https://github.com/vercel/ai-elements/blob/ca8be600bfd01b3131f9bf6134b51602a71f4374/apps/docs/components/geistdocs/deprecation-banner.tsx)。

Open WebUI 的品牌限制含不超过 50 名自然人终端用户（滚动 30 天）、书面许可或企业许可等例外。不能把当前文件简单称为 MIT，也不能把旧版许可直接套到新文件。此处是所选代码的许可核查，不是全部第三方依赖审计。

## 4. 推荐直接取用的源码

### 4.1 assistant-ui：消息和交互

以下路径均已读取；以核查提交固定链接，实际引入时锁定版本及依赖，不直接追 latest。

| 源码 | 可复用能力 | 需要修改的边界 |
| --- | --- | --- |
| [thread.aui.tsx](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/ui/src/components/react/assistant-ui/elements/thread.aui.tsx) | 消息区、输入框、Markdown、附件、工具与推理分组、回到底部 | 中文文案、样式令牌、只启用业务已支持的按钮；保留现有确认卡与回执 |
| [reasoning.tsx](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/ui/src/components/react/assistant-ui/elements/reasoning.tsx) / [reasoning.aui.tsx](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/ui/src/components/react/assistant-ui/elements/reasoning.aui.tsx) | 折叠、流式预览、时长、用户手动展开选择 | 只喂入可公开的模型内容；执行过程与推理分开；按真实事件提供时间 |
| [assistant-sidebar.aui.tsx](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/ui/src/components/react/assistant-ui/elements/assistant-sidebar.aui.tsx) | 聊天与内容左右可调整分栏的组合 | 复用项目自己的 Resizable 组件，把右侧内容换成业务成果 |
| [ExternalStoreRuntime 文档](https://www.assistant-ui.com/docs/runtimes/custom/external-store) | 将现有消息、状态、发送/停止/恢复回调接入聊天组件 | 不另建一份可写业务状态；会话 ID、消息 ID、当前执行 ID 与后端一致 |

这里的 **UI Runtime 只是前端消息与交互状态适配，不是第二套智能体编排器**。ExternalStore 模式可以继续使用项目现有请求和持久化，不要求订阅 Assistant Cloud；包中存在 cloud 依赖也不等于必须启用云端会话服务。其稳定消息身份、切会话时丢弃迟到响应等仍需接入方正确处理。[ExternalStore 源码文档](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/apps/docs/content/docs/runtimes/custom/external-store.mdx)

有一处不能当成零改造：当前 reasoning 的 [collapsible-root.tsx](https://github.com/assistant-ui/assistant-ui/blob/7d6cf6a923b5381cd5ee64847a2269f4b1b962a5/packages/ui/src/components/react/assistant-ui/elements/collapsible-root.tsx) 使用 Base UI，而本项目已有 Radix。优先将这层薄包装适配为现有 Collapsible 并检查动画/焦点/展开行为，或选用已验证的 Radix 版本；不为了一个折叠框再装整套重复基础组件。

如果后续小适配证明完整 UI Runtime 的接线收益不足，可以只取 standalone 展示组件与 shadcn Radix 模式。两条路线择一作为消息主线，不同时维护两套聊天状态管理。

### 4.2 LangChain 和 LibreChat：有用的参考，而非整套复制

- LangChain [Stream.tsx](https://github.com/langchain-ai/agent-chat-ui/blob/7a503412aeeb4534a24b04bd97b618ee3871821e/src/providers/Stream.tsx) 使用 LangGraph SDK 的 useStream，依赖 Server 的 URL、assistantId、历史与中断协议；当前项目只是嵌入 LangGraph 库，不能据此假定已有这些 HTTP 接口。
- [ai.tsx](https://github.com/langchain-ai/agent-chat-ui/blob/7a503412aeeb4534a24b04bd97b618ee3871821e/src/components/thread/messages/ai.tsx) 可参考消息、工具和中断的组织；[artifact.tsx](https://github.com/langchain-ai/agent-chat-ui/blob/7a503412aeeb4534a24b04bd97b618ee3871821e/src/components/thread/artifact.tsx) 可参考右侧成果插槽。无需照搬通用 checkpoint 调试、远端动态组件加载或任意工具批准。
- LibreChat [ConversationsSection.tsx](https://github.com/LibreChat-AI/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/client/src/components/UnifiedSidebar/ConversationsSection.tsx)、[SidePanelGroup.tsx](https://github.com/LibreChat-AI/LibreChat/blob/8d3da9bbb220a0a96be9330a2e1cbd385fb786d5/client/src/components/SidePanel/SidePanelGroup.tsx) 适合参考会话和产物区。其组件使用内部鉴权、缓存、stores 和数据包，复制完整客户端会引入大于本次 UI 目标的改造。
- Chainlit [Step.tsx](https://github.com/Chainlit/chainlit/blob/190ea74239d9e84b26e7c91bc2882dd038942564/frontend/src/components/chat/Messages/Message/Step.tsx) 与 [ElementSideView.tsx](https://github.com/Chainlit/chainlit/blob/190ea74239d9e84b26e7c91bc2882dd038942564/frontend/src/components/ElementSideView.tsx) 可参考简洁步骤和桌面分栏/窄屏抽屉；不需要一起引入 Python 服务。

LangChain 当前官方前端文档也提供 useStream、消息、任务、工具和中断展示，但文档使用新版前端 SDK；与项目锁定的运行时、现有 Fastify 传输仍须核对，不能通过复制示例假定兼容。[官方前端概览](https://docs.langchain.com/oss/javascript/deepagents/frontend/overview)

## 5. 截图到 EvalBase 的具体映射建议

| 截图区域 | 建议呈现 | 复用来源 |
| --- | --- | --- |
| 最左侧窄图标栏 | 项目/资料/测试集/助手等已有导航，保持品牌和当前项目定位 | 现有应用外壳、Sidebar |
| 左侧会话栏 | 新会话、搜索、项目内会话、重命名/删除；当前会话浅色高亮 | 现有会话接口 + shadcn Sidebar；参考 LibreChat |
| 中央对话 | 助手正文直接排版，用户消息浅色气泡；正文留白、行宽受控；表格和代码按需横滚 | assistant-ui Thread / Markdown |
| 过程输出 | 一条简洁“正在读取资料/正在生成/等待确认”，可展开真实步骤、耗时、结果 | 工具分组、Reasoning/Trace 展示组件 |
| 底部输入框 | 圆角固定输入区、附件、发送/停止；长文本自适应高度 | Composer，连接已有上传/发送/停止入口 |
| 右侧工作区 | 按需打开文档、数据预览、处理成果、保存确认；可调宽度，可关闭，窄屏用抽屉 | 现有 Resizable/Sheet 与业务预览组件，参考 Artifact |
| 操作结果 | 成功显示真实对象名称、数量、保存位置和可点击链接；错误显示简短原因及恢复操作 | 现有业务回执和固定确认 |

建议优先实现截图中有实际业务用途的区域。右侧先是业务工作区，不因为截图存在侧聊就增加第二个智能体、无限标签、嵌入浏览器、终端或代码沙箱。语音、消息分支等未接通的功能不展示空按钮。桌面系统菜单和窗口控制不属于当前 Web 页面范围。

外观方向为浅色侧栏、白色内容、细分隔线、柔和圆角、少量蓝色强调和更少常驻卡片；具体宽度、密度和字体仍需在原型中确认。保留 frontend-v1 的基础组件与业务一致性，助手页的新布局作为待确认的专属设计建议，当前研究不直接改写冻结原型或其他页面的视觉合同。

## 6. “思考过程”怎样做到真实

应区分三类内容：

1. **模型推理文本或摘要**：只有当前模型/API 确实公开返回且适合展示时，才显示独立可折叠区域。UI 库不能取得模型未提供的内部推理。本次未新增 qwen-new 请求，也没有证明它当前接入路径已输出可用的 reasoning 字段。
2. **工具与任务过程**：来自真实工具开始、后台等待、完成、失败、暂停与确认事件，如“已读取 2 份资料”“已生成 8 条，待保存”。这部分不依赖模型公开推理，最值得优先做好。
3. **最终答复与业务成果**：Markdown 正文与真实成果链接；“已保存”由事务回执确认，而非模型说一句完成就变为成功。

assistant-ui 的 reasoning 组件只是接收消息 part/文本/streaming 标记；时长也需宿主提供或从真实 part 时间计算，不能把整个 Worker 等待时长写成“思考了 N 秒”。[Reasoning 文档](https://www.assistant-ui.com/elements/reasoning)

视觉上可使用一个紧凑过程区，里面分“推理摘要”和“执行记录”，默认以摘要与当前动作占位；不把大段工具参数、堆栈和原始调试日志铺满聊天区。暂停、等待确认与请求失败不能共用一个持续转动的“思考中”。不存在推理文本时只显示真实执行状态，不让另一次模型请求编造思考过程。

## 7. 实际还需开发的接入工作

复用可以省去许多通用交互，但下面几项必须由 EvalBase 负责：

- **一层消息/事件映射**：把新运行时允许展示的正文、推理摘要、工具状态、应用确认和保存回执映射给组件；不向前端直接倾倒完整 checkpoint 或内部日志。会话、执行、消息、工具/确认使用稳定身份。
- **真实流式输出**：核对当前锁定 SDK 的流 API；以现有 Fastify 暴露受认证的流式 HTTP/SSE 路径，将公开文本增量发到 UI。流化时同时处理计量、取消、最终消息落盘和错误，不能简单将 streaming 改为 true 就宣称完成。
- **恢复与事实一致性**：刷新/断线后从持久快照恢复，再接增量；已提交结果通过稳定回执身份去重。断开 UI 连接不自动取消业务任务。停止/继续按钮调用应用既有控制，不能只关闭 fetch。
- **业务卡片**：固定确认、候选数据预览、来源和保存链接继续服从当前权限及修订；不复制通用工具审批后绕过原有确认。
- **组件与样式适配**：中文、现有别名、Radix 包装、主题令牌、窄屏和长列表。普通聊天运行中不自动夺走用户滚动位置；阅读旧消息时提示“有新内容”。

这是一条运行时到 UI 的单向展示路径，不再创建新的意图识别、规划、参数纠错或任务状态权威。采用 SSE/组件本身不会保证模型参数不再出错；本次解决的是界面复用、输出透明度与交互一致性。

## 8. 后续最小落地顺序与验收建议

本节只是下一步建议，未创建 Ticket 或启动实施。

1. 用现有组件加 assistant-ui 做一页静态交互样稿，覆盖会话侧栏、消息/过程、输入区、右侧成果。使用固定示例数据确认布局和密度，不调用模型。
2. 接新运行时的消息快照、发送和真实状态，再接流事件；明确确认与成功回执显示，保留原业务接口与预算账本。只引入选中的组件依赖。
3. 定向验证消息流、过程折叠、工具结果、确认、执行中暂停、刷新重连、重复事件和切会话迟到响应；再用小规模真实会话核对一次。模型调用需要另行记录适用上限，不重置旧活动或重跑旧验收。

验收重点应是：流式文字不跳动；读历史时不强制滚到底；工具完成和业务保存不混淆；确认不会因重连显示两份；停止后能看到正确状态；跨会话内容不串线；右侧预览与保存对象一致。外观接近截图和运行行为正确要分别验证，不能用静态截图代替后者。

## 9. 证据边界与本次交付

已查看官方文档、根许可证、依赖清单和关键源文件。源码链接固定到核查提交；仓库归档及在线文档反映核查日期状态。部分大型组件只审阅了相关逻辑与导入，未声称完整依赖审计。

本次仅新增此研究记录，未改业务代码、PRD、架构决策或冻结原型；未安装依赖、部署环境、调用模型或新开预算；现有验收数据和旧预算不变。实际采用需经过小适配和页面验证，不能把“源码允许复用”写成“已无缝兼容”。
