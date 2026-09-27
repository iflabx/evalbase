# EvalBase 系统流程图

本图以 `92cb8a5` / `prototype/solo-workflow-v5.3` 为完整用户交互合同。正式产品只实现图中的可见动作；内部机制不得增加页面或步骤。

静态图：[PNG](./system-flow-v2.png)；Mermaid 源文件：[MMD](./system-flow-v2.mmd)。

## 1. 单人主流程

```mermaid
flowchart LR
    Owner["Project Owner / Sole Developer"] --> Projects["项目列表<br/>搜索 · 分页 · 新建 · 打开"]
    Projects --> Workspace["当前项目<br/>数据集 / 测试集"]

    subgraph Datasets["数据集"]
        DatasetList["数据集列表<br/>搜索 · 筛选 · 排序 · 分页"]
        Upload["两步上传<br/>选择文件 → 拖拽字段映射与预览"]
        Confirm{"确认保存？"}
        Cancel["取消/失败<br/>无可见资产"]
        Files["文件 / 全部记录<br/>移动 · 查看 · 原始内容"]
        Records["序号详情 · Metadata 键值<br/>紧凑 / 适中 / 展开"]
        Raw["页内只读原始预览<br/>最多 1,000,000 bytes"]
    end

    subgraph TestSets["测试集"]
        Select["选择数据集 / 文件 / 记录"]
        Edit["三列表格增删改<br/>问题 · 期望输出 · Metadata 键值"]
        Publish["创建不可变版本<br/>vN / vN-bK"]
        Graph["版本关系图<br/>历史不覆盖"]
        VersionRecords["版本记录<br/>搜索 · 分页 · 固定筛选 · 详情<br/>紧凑 / 适中 / 展开"]
        Provenance["来源与修改<br/>未改变 / 修改 / 新增 / 移除"]
        Download["当前版本下载<br/>数据 CSV + provenance CSV"]
        Trash["回收站<br/>分组恢复或精确输入永久删除"]
        Tombstone["中间版本墓碑<br/>保留父子关系"]
    end

    Workspace --> DatasetList --> Upload --> Confirm
    Confirm -- "否" --> Cancel
    Confirm -- "是" --> Files --> Records --> Select
    Records --> Raw
    Workspace --> Select
    Select --> Edit --> Publish --> Graph
    Graph -- "从任一版本派生" --> Select
    Graph --> VersionRecords
    Graph --> Provenance --> Download
    Graph --> Trash
    Trash -- "恢复" --> Graph
    Trash -- "永久删除" --> Tombstone
    Graph -- "删除中间版本内容" --> Tombstone

    Internal["不可见内部机制<br/>持久化 · 容量 · 幂等 · 原子发布 · 项目隔离 · 安全删除"]
    Internal -. "支撑，不增加用户步骤" .-> Upload
    Internal -. "支撑，不增加用户步骤" .-> Publish
    Internal -. "支撑，不增加用户步骤" .-> Trash

    Future["当前范围之外<br/>登录/多人 · 高级解析 · 任意/保存筛选 · Schema · Package/CLI · Langfuse · 评测 · 生产"]
    Graph -.-> Future

    classDef future fill:#f8fafc,stroke:#64748b,stroke-width:1px,stroke-dasharray:5 5,color:#334155
    class Future future
```

### 读图重点

- 应用无登录，首屏是项目列表；进入项目后只有数据集和测试集两个子入口。
- “数据集”是原始文件容器，不是测试集。上传只有选择文件、拖拽字段映射与预览两步；Metadata 保留字段和值的边界。
- 记录通过序号打开详情。单文件原始内容只在当前页只读预览开头最多 1,000,000 bytes，并在截断时明确提示。
- 用户从真实记录创建 `v1`，后续从任一历史版本派生；任何版本都不覆盖。
- 版本记录以服务端搜索、分页和固定筛选浏览；多个筛选条件同时满足，多选来源文件在来源条件内匹配任一项。
- 来源页只解释直接父版本、新加入资料和逐条增删改。
- 下载是当前版本数据 CSV，以及数据 CSV + provenance CSV 两个独立文件。
- 测试集列表的垃圾桶只回收整套测试集；回收站按测试集和版本分组，恢复整套测试集会恢复其已吸收版本，永久删除与墓碑须精确输入名称或版本号。
- 持久化、容量、幂等、项目隔离和安全删除是不可见机制。

## 2. 前端与后端职责

```mermaid
flowchart LR
    Prototype["冻结原型 v5.3<br/>完整交互合同"] --> V3["frontend-v3<br/>新正式 React 前端"]
    Donor["frontend-v1<br/>只读视觉与组件 donor"] -->|"Ticket 20 完整复制"| V3
    Deprecated["frontend-v2<br/>废弃实验前端"] -. "不复制、不构建、不部署" .-> V3
    V3 --> API["单人工作流 HTTP 接口"]
    API --> Core["内部领域能力<br/>解析 · 版本 · 来源 · CSV · 删除"]
    Core --> PG[(PostgreSQL)]
    Core --> MinIO[(MinIO)]
    Old["src/web<br/>旧 Web"] -. "Ticket 27 退出运行路径" .-> V3
```

`frontend-v1/` 永久保持不变。`frontend-v3/` 直接继承 donor 的字体、布局、样式和组件，再按冻结原型连接真实 API。`frontend-v2/` 保留 Git 历史但不再作为开发、预览、构建、部署或回滚目标。

## 3. 版本与来源

```mermaid
flowchart LR
    Source["数据集文件 / 原始记录"] --> V1["v1"]
    V1 --> V2["v2"]
    V2 --> V3["v3"]
    V1 --> B1["v2-b1"]
    B1 --> B2["v3-b1"]
    V3 --> CSV1["数据 CSV / provenance CSV"]
    B2 --> CSV2["数据 CSV / provenance CSV"]
    Tomb["墓碑版本"] -. "保留原父子边" .-> B1
```

版本图只表达版本父子关系；逐条来源仍指向数据集、文件、原始记录、父修订或手工新增事实。所有浏览和下载都绑定当前选中版本。
