# 测试集与版本删除模式调研

| 项目     | 内容                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 调研日期 | 2026-08-31                                                               |
| 调研问题 | 测试集和单个版本能否删除；删除中间版本时如何保留后代版本的历史与数据溯源 |
| 资料范围 | 仅使用项目官方文档、官方源码或官方规范                                   |
| 文档效力 | 原型决策参考；不修改 PRD、CONTEXT、Architecture、ADR 或正式业务合同      |

## 1. 结论

最适合 EvalBase 原型的不是一个笼统的“删除”，而是四个含义明确的动作：

| 用户意图                       | 原型推荐动作                       | 历史与内容结果                                           |
| ------------------------------ | ---------------------------------- | -------------------------------------------------------- |
| 不想在日常列表中看到某个测试集 | 移入回收站                         | 可恢复；测试集、版本、内容和溯源全部保留                 |
| 确认不要整个测试集             | 在回收站中永久删除                 | 删除该测试集的全部版本和溯源；原始资料保持独立           |
| 不想保留没有后代的版本         | 移入版本回收站                     | 可恢复；永久删除须在回收站再次确认，版本号不复用         |
| 想删除有后代的中间版本         | 删除整个后续分支，或保留墓碑删内容 | 绝不改写后代父版本；后者保留最小节点和真实父子关系       |
| 放弃尚未发布的编辑结果         | 放弃草稿                           | 可以真删除，因为它还不是正式历史版本                     |
| 必须移除已经发布的内容         | 先做实际内容影响检查，再删除       | 受影响后代也不可继续暴露被删内容；不按单纯版本位置一刀切 |

因此，建议采用以下规则：

1. **原型中的测试集删除先进入回收站。**整个测试集可在回收站中永久删除；这只删除测试集及其版本，不删除独立管理的原始资料。
2. **没有后代的版本可以进入回收站。**中间版本不能普通硬删除；用户只能删除整个后续分支，或让版本节点转为“内容已删除”的墓碑。
3. **删除中间节点时绝不改写后代的父版本。**后代继续指向原父版本墓碑，不能把 `v1 -> v2 -> v3` 偷换成 `v1 -> v3`。
4. **是否连带影响后代取决于真实内容依赖，不取决于它是不是后代。**如果后代复用了被删记录、文件或证据，影响闭包必须把后代一并标为不可用；如果后代有独立冻结的完整载荷且不再引用被删内容，它可以继续使用，但溯源仍经过墓碑节点。
5. **物理清除与用户界面动作分离。**先完成引用分析和状态切换，只有在没有未受影响引用后才清理共享底层对象；垃圾回收不应成为普通用户按钮。

```text
仅 v2 内容被移除，v3 不依赖被移除内容：

v1 ──▶ [v2 内容已受控删除] ──▶ v3（仍可用）

v3 复用了 v2 中被移除的内容：

v1 ──▶ [v2 内容已受控删除] ──▶ [v3 内容已受控删除]
```

无论哪一种情况，都不删除中间节点、不重接边、不重命名后代，也不重算已经发布的溯源事实。

## 2. Dataverse：最适合作为主要产品参考

### 2.1 官方语义

Dataverse 明确区分草稿与已发布历史：

- Native API 的 `Delete Dataset Draft` 只允许删除 draft；官方原文是“Only the draft version can be deleted”。
- 已发布的数据集或指定已发布版本使用 `Deaccession`，而不是普通删除。操作要求选择理由，可填写补充说明和替代地址。
- Deaccession 后，持久地址仍显示带基本引用元数据的 tombstone；原文件和额外元数据不再公开。
- 可以撤下整个数据集，也可以只撤下一个版本。若只撤下最新版本，可以回到更早版本继续创建新的草稿。
- 发布后的文件替换会形成新草稿和新版本；先前版本及文件历史仍可从版本记录访问，后来的修改不会改写旧发布版本。
- 官方另有仅限 superuser 的 `destroy` 接口，并明确它永久、不可逆，会删除数据集及其数据文件；这不是普通用户生命周期操作。

来源：

- [Delete Dataset Draft](https://guides.dataverse.org/en/latest/api/native-api.html#delete-dataset-draft)
- [Dataset Deaccession](https://guides.dataverse.org/en/latest/user/dataset-management.html#dataset-deaccession)
- [Replace Files](https://guides.dataverse.org/en/latest/user/dataset-management.html#replace-files)
- [Delete Published Dataset](https://guides.dataverse.org/en/latest/api/native-api.html#delete-published-dataset)
- [固定版本：Deaccession 文档源码](https://github.com/IQSS/dataverse/blob/bcb111cf0cd0c8731532e66e964b494a324f1b8a/doc/sphinx-guides/source/user/dataset-management.rst#L829-L844)
- [固定版本：Draft delete / Deaccession API 源码](https://github.com/IQSS/dataverse/blob/bcb111cf0cd0c8731532e66e964b494a324f1b8a/doc/sphinx-guides/source/api/native-api.rst#L3011-L3053)

### 2.2 可以借鉴

- 把“放弃未发布草稿”和“撤下正式版本”设计成两个不同动作。
- 已发布版本即使内容不可访问，也保留稳定身份、版本标签、理由和最小墓碑。
- 整个测试集和单个版本都可以进入不可用状态，但不会因此篡改其他版本的历史。
- 将不可逆的彻底清除隔离成非常规管理能力，不放在普通列表的显眼位置。

### 2.3 不应照搬

- 不引入 DOI、公共发布、引用规范、仓储管理员和复杂权限。
- Deaccession 表示撤下访问，不等于已经证明底层字节物理擦除；EvalBase 若需要清除内容，仍需自己的依赖闭包和存储清理规则。
- Dataverse 主要是线性发布历史，不能直接解决 EvalBase 原型正在验证的分支版本图；父子关系仍需由 EvalBase 自己稳定保存。

## 3. CKAN：借鉴“日常删除”和“彻底清除”分层

### 3.1 官方语义

CKAN 的 `package_delete` 会让数据集从普通 Web/API 视图消失，但仍保留在 trash 中。`dataset_purge` 才会把数据集从 CKAN 数据库完全移除，官方明确警告 purge 不可撤销。数据集的 `state` 也明确区分 `active` 与 `deleted`，普通搜索和列表只显示 active。

来源：

- [CKAN API：package_delete](https://docs.ckan.org/en/2.11/api/index.html#ckan.logic.action.delete.package_delete)
- [CKAN API：dataset_purge](https://docs.ckan.org/en/2.11/api/index.html#ckan.logic.action.delete.dataset_purge)

### 3.2 可以借鉴

- 用户可见的移除默认是可管理的逻辑状态，而不是立即销毁数据库身份。
- 不可逆清除应单独命名、单独授权、单独警告，不能和日常整理共用一个垃圾桶按钮。

### 3.3 不应照搬

- CKAN 的 dataset delete/purge 主要处理容器，不提供适合版本分支和中间节点溯源的模型。
- EvalBase 原型是单人使用，不需要照搬 CKAN 的 sysadmin、组织或 trash 管理界面。

## 4. DVC：借鉴“按引用保留，再做垃圾回收”

### 4.1 官方语义

DVC 的 `gc` 清理缓存或远端存储中不再需要的对象。它要求显式给出 workspace、branches、tags、commits 等保留范围；保留对象由指定提交范围内的 DVC 文件决定。`--all-commits` 会保留整个 Git 提交历史引用的数据。仅清理本地缓存时，只要内容已推送到 remote 仍可重新取回；使用 `--cloud` 清理远端则可能不可逆。官方还特别警告，共享 cache/remote 时必须考虑其他项目引用，否则会破坏它们的数据链接。

来源：

- [DVC `gc` command](https://dvc.org/doc/command-reference/gc)
- [DVC `gc --all-commits`](https://dvc.org/doc/command-reference/gc#-A)
- [DVC remote deletion warning](https://dvc.org/doc/command-reference/gc#removing-data-in-remote-storage)

### 4.2 可以借鉴

- 先确定“哪些正式版本仍引用这个对象”，再决定底层字节能否删除。
- 共享内容只要仍被任一未受影响版本引用，就不能物理清除。
- 把历史/引用管理与存储空间回收拆成两个阶段。

### 4.3 不应照搬

- 不把 Git commit、tag、cache、remote 或 GC 参数暴露给 EvalBase 普通界面。
- DVC 管的是内容寻址缓存，不负责用户能理解的墓碑、删除理由或版本降级状态。

## 5. lakeFS：最适合补强中间节点与共享对象语义

### 5.1 官方语义

lakeFS 默认不会立即从底层存储移除已删除或替换的对象。垃圾回收按照 retention 规则工作；当同一对象存在于多个 branch ancestry 时，只有所有相关分支的保留期都结束后才能移除。官方还明确说明：GC 不删除 commit；包含已清除对象的 commit 仍然存在，但读取对应对象会得到 `410 Gone`。

来源：

- [lakeFS Garbage Collection](https://docs.lakefs.io/admin/garbage-collection/)
- [lakeFS Garbage Collection Notes](https://docs.lakefs.io/admin/garbage-collection/#garbage-collection-notes)

### 5.2 可以借鉴

- 历史节点可以继续存在，同时其载荷已经不可读；这正适合版本墓碑。
- 清除共享对象前必须确认所有有效引用，而不是只看直接目标版本。
- 可以采用 `标记影响 -> 确认 -> 清理` 的思想，但原型界面只需要用户能理解的影响预览，不需要暴露 GC 实现。

### 5.3 不应照搬

- 不引入 Spark、对象存储分支、retention 配置或 mark/sweep 运维界面。
- `410 Gone` 是 lakeFS 的读取结果，不必成为 EvalBase 的用户文案；界面直接显示“内容已受控删除”更清楚。

## 6. MLflow Model Registry：只借少量内部不变量

### 6.1 官方语义

MLflow 当前工作流文档把删除指定 model version 或整个 registered model 描述为不可逆操作。其 SQLAlchemy backend 对单个版本的实际处理是：把版本标记为内部 deleted stage，删除指向它的 aliases，并清空或脱敏 source、run、user 等字段；公共读取把它视为不存在。新版本号根据数据库中已有最大版本号继续递增，因此删除后不会复用编号。删除整个 registered model 则直接删除容器记录及关联版本。

来源：

- [MLflow：Deleting MLflow Models](https://mlflow.org/docs/latest/ml/model-registry/workflow/#deleting-mlflow-models)
- [固定版本：删除工作流文档](https://github.com/mlflow/mlflow/blob/433b43683bd86923b4105878c18d4d14698c432f/docs/docs/classic-ml/model-registry/workflow.mdx#L558-L575)
- [固定版本：SQLAlchemy model-version delete](https://github.com/mlflow/mlflow/blob/433b43683bd86923b4105878c18d4d14698c432f/mlflow/store/model_registry/sqlalchemy_store.py#L1244-L1273)
- [固定版本：version number allocation](https://github.com/mlflow/mlflow/blob/433b43683bd86923b4105878c18d4d14698c432f/mlflow/store/model_registry/sqlalchemy_store.py#L1136-L1145)

### 6.2 可以借鉴

- 已使用的版本号永不复用。
- 版本不可用时，必须移除 default/alias 等活动引用。
- 正式内容被清除后只保留必要的内部身份，不能继续暴露载荷字段。

### 6.3 不应照搬

- MLflow model version 不是父子版本图，也没有 EvalBase 所需的后代依赖闭包。
- 整个 registered model 的不可逆删除过于激进，不适合作为 EvalBase 日常测试集操作。
- MLflow 的内部 deleted stage 不提供面向用户的可解释墓碑和完整溯源策略。

## 7. 推荐的原型交互

为保持单人产品简单，原型不增加第三个一级页面或复杂设置页。回收站只从“测试集”页头打开；版本动作只在正在浏览的版本详情页出现：

### 7.1 测试集回收站

- `移入回收站`：从默认列表移出；测试集、版本、内容和溯源仍在浏览器内存中，可恢复。
- `永久删除`：只从回收站出现；确认后删除测试集和全部版本。它不删除原始资料。
- 原型不使用“归档 / 停用 / 撤下”等多个近义词，以免单人界面变复杂。

### 7.2 版本删除

- 末端版本的“删除此版本”会移入回收站；恢复和永久删除均在回收站中完成。
- 中间版本显示“处理中间版本”，并明确给出两种互斥选项：`删除此版本及后续分支`，或 `删除此版本内容，保留关系`。
- 后一种选择会显示最小墓碑。原型把后代视为独立快照以验证版本图交互；正式系统不能据此跳过真实内容依赖检查。

### 7.3 版本图

内容被删除的中间版本保留原标签和边，节点使用灰色虚线样式并显示“内容已删除”；预览、下载、编辑和创建新版本操作禁用。后代版本仍然保留原父版本字段，不会被改挂到祖先节点。

影响预览至少回答四个问题：

1. 哪个版本或哪些记录是直接删除目标？
2. 哪些后代复用了这些内容，因而会一起不可用？
3. 哪些后代拥有独立完整载荷，可以继续使用？
4. 当前默认版本是否受影响，确认后是否需要清空默认选择？

## 8. 原型阶段暂不加入

- 不实现历史节点拼接、改父版本、重写溯源或复用旧版本号。
- 不实现分支合并、rebase、版本恢复内容或撤销已经确认的受控删除。
- 不实现垃圾回收配置、保留天数、共享对象手工管理或底层存储运维 UI。
- 不把归档、放弃草稿和受控删除都塞进同一个“删除”按钮。
- 不声称原型已经完成物理擦除、隐私合规或生产数据删除保证。
