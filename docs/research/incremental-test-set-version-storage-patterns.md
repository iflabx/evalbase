# EvalBase 测试集增量版本存储模式调研

- 调研日期：2026-09-16
- 调研范围：测试集记录发生少量修改时，如何避免客户端、PostgreSQL 和 MinIO 重复处理整份版本
- 证据范围：EvalBase 当前源码，以及 Git、Dolt、Delta Lake、Apache Iceberg、Apache Hudi、lakeFS、DVC、Langfuse 的官方文档、规范或官方源码
- 本文性质：技术研究与建议，不是产品合同、ADR 或实施批准

## 1. 结论

EvalBase 当前确实存在写放大，但问题需要精确拆开：**未修改记录的正文已经复用，并没有在 PostgreSQL 中复制 10,000 份 JSON；重复发生在完整客户端载荷、完整 MinIO 记录对象，以及每个版本完整的 `version_member` 成员关系。**

对于“10,000 条记录只修改 1 条并发布新版本”，最适合 EvalBase 的方案不是直接接入 Dolt、Delta Lake、Iceberg、lakeFS 或 DVC，而是继续使用 PostgreSQL + MinIO，并把版本存储改为：

> **不可变版本节点 + 记录级稀疏变更集 + 周期性完整成员检查点 + 按需生成并缓存完整下载工件。**

核心结果是：

- 浏览器只提交发生变化的记录操作，不再回传 10,000 条完整记录；
- PostgreSQL 只新增被修改记录的 `case_revision` 和少量 `version_change`，不再为每个版本写入 10,000 条成员关系；
- MinIO 每次发布只保存小型增量 manifest；完整 CSV/数据与溯源包在下载时流式生成，并按版本哈希缓存；
- 为避免历史版本读取随版本链无限变慢，由现有 Worker 在达到阈值时生成一次完整成员检查点；
- 版本仍然是不可变快照，用户看到的分支、来源、修改记录和下载结果不需要改变。

这个方案主要借鉴：

- Langfuse：一条记录更新只产生该记录的新历史行；
- Delta Lake：增量事务日志配合周期检查点，限制日志回放成本；
- Apache Hudi：Merge-On-Read 先追加记录级增量，再用周期 compaction 摊销完整物化成本；
- Iceberg：快照复用未变化的数据/manifest，并将逻辑删除与物理回收分离；
- Git、Dolt 和 lakeFS：不可变对象、内容哈希、父节点和结构共享的思想。

不建议现在实现 Dolt 式 Prolly Tree。它在理论上能让写入、读取和 diff 都非常优雅，但自研内容寻址持久树、分块、GC、并发提交与损坏恢复，会显著扩大 EvalBase 的实现和运维面。只有未来达到百万级记录、大量分支或数百个版本，并且下述稀疏变更方案经过测量仍不够时，才值得重新评估。

## 2. EvalBase 当前数据流及真正的写放大

### 2.1 当前行为

当前前端会分页读取父版本的全部记录，再把编辑后的全部记录放入 `records` 提交给派生版本接口：

- [`listAllSoloVersionRecords`](../../frontend-v3/src/services/workspace.ts#L544) 会以每页 100 条读完整个版本；
- [`deriveSoloTestSetVersion`](../../frontend-v3/src/services/workspace.ts#L573) 会把完整 `records` 数组序列化进请求；
- 服务端派生版本接口明确接收最多 10,000 条记录，[见请求校验](../../src/server/app.ts#L1903)。

服务端随后：

1. 读取父版本的全部 `version_member` 和 `case_revision`，[见父成员查询](../../src/server/app.ts#L2173)；
2. 为全部记录生成 JSONL `payload`，并向 MinIO 写入包含全部 `records` 的不可变对象，[见对象写入](../../src/server/app.ts#L2226)；
3. 对每条提交记录与父记录进行比较；
4. 未变化记录复用旧 `case_revision`，但仍为新版本插入一条新的 `version_member`，[见 unchanged 分支](../../src/server/app.ts#L2338)；
5. 只有变化记录才新增 `case_revision`，并通过 `parent_revision_id` 指向旧修订，[见修订写入](../../src/server/app.ts#L2371)。

数据库模型也印证了这一点：`case_revision` 保存记录正文和修订父链，而 `version_member` 保存每个版本的完整成员清单，[见数据库定义](../../src/db/migrate.ts#L587)。

### 2.2 修改 1/10,000 条时的成本

设版本记录数为 `N=10,000`，实际变化数为 `D=1`：

| 层 | 当前成本 | 是否必要 |
|---|---:|---|
| 浏览器读取 | 读取 `N` 条进入编辑状态 | 当前 UI 需要，但以后可以按需编辑 |
| 浏览器提交 | 上传 `N` 条完整记录 | 不必要 |
| 服务端比较 | 读取并比较 `N` 条 | 可降为验证 `D` 条，完整 hash 可流式计算 |
| PostgreSQL 记录正文 | 新增 `D` 条 `case_revision` | 合理，当前已做到 |
| PostgreSQL 版本成员 | 新增 `N` 条 `version_member` | 可改为 `D` 条变更 + 偶尔检查点 |
| MinIO | 新增一份含 `N` 条记录的完整对象 | 可改为小型增量 manifest，完整下载按需生成 |

因此，当前设计不是“每次在数据库里复制 10,000 条完整数据”，但随着版本数增加，网络传输、顺序 INSERT、成员索引和 MinIO 完整对象仍会近似按 `版本数 × N` 增长。用户对长期速度和容量的担忧成立。

## 3. 一手项目调研

### 3.1 Git：完整快照语义，内容寻址复用对象

Git 官方资料将 Git 描述为内容寻址文件系统。文件内容保存为 blob；tree 保存文件名到 blob/子 tree 哈希的映射；commit 指向顶层 tree 和父 commit。因此 commit 在语义上是完整快照，但未变化的 blob 和子 tree 可以被新快照继续引用，而不必重新存储。[Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)

Git 还会把松散对象打进 packfile，并可把相似对象之一保存为另一对象的 delta，以减少物理空间。[Git Packfiles](https://git-scm.com/book/en/v2/Git-Internals-Packfiles)

对 EvalBase 的启示：

- 版本可以保持“完整快照”的用户语义，同时在物理层复用未变化内容；
- 父版本指针、不可变对象和内容哈希值得保留；
- Git 的复用粒度默认是文件/树。如果 10,000 条记录仍是一个 JSONL/CSV blob，任意一条变化首先会产生一个新 blob；packfile 的事后 delta 压缩不能直接解决交互式记录查询和 PostgreSQL 成员写入。

### 3.2 Dolt：Prolly Tree 提供记录级结构共享和快速 diff

Dolt 的官方 Prolly Tree 文档明确列出三个目标：接近 B-tree 的读写性能、差异规模相关的快速 diff、以及版本间结构共享。数据按内容确定的边界切块，块以内容地址保存。修改一个值时，复制并重写所在叶块，再向上重算到根；未受影响的块继续共享。文档给出的随机读为近似 `O(log n)`，diff 为近似 `O(d)`。[Dolt Prolly Tree](https://dolthub.com/docs/architecture/storage-engine/prolly-tree/)

其重要特点是 chunk 边界由内容/键确定，而不是简单的固定“每 500 行一块”。因此插入或删除一条记录通常不会让后续所有块整体错位；相同子树哈希也可直接跳过 diff。

对 EvalBase 的启示：

- 这是从数据结构层面解决“只改一行却重写全量”的最完整模式；
- 稳定 `case_id` 可作为树键，内容寻址块可放入 MinIO，版本只保存 root hash；
- 但它要求自研或引入一整套持久树、块格式、缓存、损坏校验、GC 和并发提交逻辑。直接以 Dolt 替换 PostgreSQL 还会影响现有 SQL、迁移、备份和部署，不符合当前项目的最小变更原则。

结论：**借鉴结构共享思想，不在当前阶段照搬 Prolly Tree 实现。**

### 3.3 Delta Lake：变更日志、删除向量与周期检查点

Delta 协议通过有序事务日志中的 actions 重建表快照；checkpoint 保存截至某版本的完整有效状态，使读取者不必从最早日志开始回放。官方协议鼓励合理频率的 checkpoint，避免读者承担过多 delta 文件回放成本。[Delta Protocol — Checkpoints](https://github.com/delta-io/delta/blob/79f8a92a6ec304d9471f4626298750d56ed6b6f0/PROTOCOL.md#checkpoints)

默认情况下，删除数据文件中的一行需要重写整个 Parquet 文件。启用 deletion vector 后，部分 DELETE/UPDATE/MERGE 操作可先标记旧文件中的失效行，而不重写原文件；读取时把 deletion vector 应用到当前表状态，之后再通过重写/整理把逻辑变化物化。[Delta Deletion Vectors](https://docs.delta.io/latest/delta-deletion-vectors.html)

旧数据文件不会立即物理删除，而是在保留期后由 VACUUM 回收；协议说明不再属于最新版本的文件可以延迟删除。[Delta Protocol](https://github.com/delta-io/delta/blob/79f8a92a6ec304d9471f4626298750d56ed6b6f0/PROTOCOL.md)

对 EvalBase 的启示：

- “小增量日志 + 周期完整检查点”能同时控制写放大和历史读取成本；
- 删除先写 tombstone、读取时合并，物理回收后置；
- Delta 仍是面向 Parquet 文件和分析引擎的表格式，引入它会带来 Spark/Parquet/协议兼容与运维成本。EvalBase 不需要采用 Delta 本身。

### 3.4 Apache Iceberg：snapshot → manifest list → manifest → data/delete file

Iceberg 规范把表状态表示为 snapshot。snapshot 指向 manifest list，manifest list 指向多个 manifest，manifest 再列出 data/delete files。官方规范明确说明：manifest 可以跨 snapshot 复用，避免重复写入变化缓慢的元数据。[Iceberg Table Spec — Overview](https://iceberg.apache.org/spec/#overview)

Iceberg v2 加入 delete files，可用文件路径和行位置或等值条件标记行删除，不重写不可变数据文件；读取时将 delete files 合并应用到数据文件。[Iceberg Table Spec — Row-level deletes](https://iceberg.apache.org/spec/#row-level-deletes)

物理文件只有在最后一个仍引用它的 snapshot 被清理后才可删除；规范通过 snapshot expiration/GC 将历史可见性和物理清理分开。[Iceberg Table Spec — Table metadata](https://iceberg.apache.org/spec/#table-metadata)

对 EvalBase 的启示：

- 分层 manifest 可以只重写发生变化的一部分索引，而不是整个版本；
- 不可变数据 + 逻辑删除 + 延迟 GC 能保护旧版本；
- Iceberg 的粒度仍主要是 data file 和 delete file，完整实现包含 Avro/Parquet、scan planning、sequence number 和 compaction，远超当前需要。

### 3.5 Apache Hudi：Merge-On-Read 明确交换写放大和读放大

Hudi 官方把 Copy-On-Write 与 Merge-On-Read 分开：Copy-On-Write 的更新会重写 base files，读时无需合并；Merge-On-Read 则把更新和删除先写入轻量 delta log，snapshot query 在读取时动态合并 base file 与 log，再由周期 compaction 生成新的 base file。官方对比表把 MoR 写放大描述为与变化记录数相关，同时承认读取需要合并变化记录。[Apache Hudi Table & Query Types](https://hudi.apache.org/docs/table_types/#merge-on-read-table)

Hudi 还强调，周期 compaction 把多次增量写的完整重写成本合并到一次后台工作中，使写延迟降低，但 compaction 时机决定 snapshot freshness 和 read-optimized query 的可见范围。

对 EvalBase 的启示：

- 稀疏 `version_change` 就相当于记录级 delta log；
- 最近完整成员检查点相当于 base state；
- Worker 周期生成检查点相当于 compaction；
- 完整版本页面需要“检查点 + delta”得到最新 snapshot，不能把只看检查点的旧状态误当最新版本；
- Hudi 本身仍依赖数据湖文件格式与表服务，EvalBase 只应借鉴这个成本模型，不应接入 Hudi。

### 3.6 lakeFS：对象级零复制分支与 Merkle range 复用

lakeFS 管理对象存储中对象的指针和元数据，而不把对象数据本身存入 lakeFS。branch 是 commit 指针加未提交变更，因此创建分支是零复制操作；未变化版本可映射到同一物理对象。[lakeFS Concepts and Internals](https://docs.lakefs.io/concepts/internals/)

其提交元数据使用内容寻址的 range 和 meta-range 形成两层 Merkle 结构。官方文档以“只改变一个 range”为例：新 commit 复用其他所有 range，只重建变化 range 和 meta-range，使 commit 大致与差异规模相关。[lakeFS Versioning Internals](https://docs.lakefs.io/concepts/internals/#versioning-internals)

lakeFS 是格式无关的对象版本系统，合并以完整文件是否变化为基础，并不理解 CSV/JSONL 内的测试记录。对象只有在所有引用分支都不再需要且保留期结束后才由 GC 删除。[lakeFS Garbage Collection](https://docs.lakefs.io/admin/garbage-collection/)

对 EvalBase 的启示：

- MinIO 中不可变对象、逻辑地址到物理地址映射、引用可达性 GC 都值得借鉴；
- 如果 EvalBase 仍把整个版本放在一个对象中，lakeFS 只能复用未变化对象，不能自动进行记录级增量；
- 再部署一层 lakeFS 并不能替代 PostgreSQL 中的记录、筛选、来源和版本成员模型。

### 3.7 DVC：文件级内容寻址去重，不是记录级版本数据库

DVC 官方文档说明其 cache 是内容寻址存储：文件按内容 hash 存放，相同内容的不同文件只保存一份；目录以一个 `.dir` JSON 对象列出内部文件及各自 hash。[DVC Internal Files](https://dvc.org/doc/user-guide/project-structure/internal-files#structure-of-the-cache-directory)

未被指定 workspace/commit/branch 引用的 cache 对象可由 `dvc gc` 清理。[DVC GC](https://dvc.org/doc/command-reference/gc)

对 EvalBase 的启示：

- 内容 hash 和不可变对象能自然去重完全相同的文件；
- 但一份 10,000 行 CSV/JSONL 只改一行，整个文件 hash 就改变，仍会保存新文件；
- 把每条记录拆成一个文件会带来海量小对象、目录 manifest 和查询问题，也不能替代 PostgreSQL 的筛选、来源和版本图。

结论：**DVC 适合大文件工件版本，不适合作为 EvalBase 的记录级版本引擎。**

### 3.8 Langfuse：时间有效区间实现稀疏记录历史

当前 Langfuse 官方源码已经存在明确的 Dataset Item 版本机制，并非“不适用”：`DatasetItem` 使用 `(id, projectId, validFrom)` 作为键，并保存 `validTo` 和 `isDeleted`。[Langfuse Prisma schema](https://github.com/langfuse/langfuse/blob/1de31c0e40ee73a6cc4ec427a92f19aebf950999/packages/shared/prisma/schema.prisma#L654-L686)

更新一条 Dataset Item 时，VERSIONED 路径会：

1. 把当前行的 `validTo` 设置为新时间；
2. 只插入这一条记录的新版本。

删除时同样先关闭旧有效区间，再插入 `isDeleted=true` 的删除标记。[Langfuse dataset item repository](https://github.com/langfuse/langfuse/blob/1de31c0e40ee73a6cc4ec427a92f19aebf950999/packages/shared/src/server/repositories/dataset-items.ts#L425-L489)

读取历史版本时使用 `valid_from <= version AND (valid_to IS NULL OR valid_to > version)`，因此只更新一条记录不会产生整份 dataset 的成员副本。[Langfuse temporal query](https://github.com/langfuse/langfuse/blob/1de31c0e40ee73a6cc4ec427a92f19aebf950999/packages/shared/src/server/repositories/dataset-items.ts#L1260-L1340)

局限是：从当前官方实现看，dataset 版本主要由时间点表示；它适合线性记录历史，但没有直接提供 EvalBase 当前“从任意父版本派生、形成显式分支图”的版本节点语义。时间有效区间在多分支下也不能简单共享一个全局 `validTo`。

对 EvalBase 的启示：

- 最值得直接借鉴的是“一条变化只新增一条记录历史”和删除标记；
- EvalBase 必须保留显式 `test_set_version.parent_version_id`，不能原样复制 Langfuse 的全局时间区间模型。

## 4. 横向比较

| 方案 | 提交载荷 | 存储放大 | 读取成本 | 差异/溯源 | 删除与 GC | 实现复杂度 | EvalBase 适配性 |
|---|---|---|---|---|---|---|---|
| Git | 新 commit/tree；变化文件产生新 blob | 未变化 blob/tree 共享，pack 可再做 delta；单个大文件仍先产生新 blob | 按树/对象读取快 | 文件/树级 diff 强；非记录语义 | 可达对象保留，GC/prune 不可达对象 | 中等，但粒度不匹配 | 借鉴对象/父链/hash，不直接使用 |
| Dolt Prolly Tree | 变化键对应的叶块及到根路径 | 结构共享，接近变化量 | `O(log n)` 点查，scan 正常 | diff 接近差异量，记录级很强 | 需内容块可达性 GC | 很高 | 长期理论最优，当前不值得自研/替换 PG |
| Delta Lake | 事务日志 actions；DV 可记录失效行 | 旧文件保留，增量小；需后续 compaction/VACUUM | 日志 + checkpoint；DV 增加 merge-on-read | 表版本和文件 action 完整，记录来源需另建 | 保留期后 VACUUM | 很高，依赖湖表生态 | 借鉴日志+检查点，不引入产品 |
| Iceberg | 新 snapshot/manifest；新增 data/delete files | 复用 data files/manifests；小更新仍有新小文件 | manifest 规划 + delete merge | 快照/file/row delete 清楚 | snapshot 过期后回收无引用文件 | 很高 | 借鉴分层 manifest 和可达性，不引入产品 |
| Hudi Merge-On-Read | 变化记录追加到 delta log | 写放大接近变化量；compaction 后台摊销 | snapshot 读合并 base + log；compaction 后下降 | timeline 和增量记录清楚 | cleaner/compaction 维护旧文件 | 很高，依赖湖表生态 | 最直接支持 delta + 周期检查点的成本模型，不引入产品 |
| lakeFS | 变化对象与 commit metadata | 未变化对象/range 共享；变化的单个对象仍全量 | 元数据 range + 对象读取 | 对象级 diff/分支强，文件内部不感知 | 跨分支可达性 + retention GC | 高，且增加服务 | 适合对象层，不解决记录层 |
| DVC | 新 hash 指针；变化文件重新缓存 | 相同文件去重；单大文件一行变化仍生成新对象 | checkout/pull 文件，不面向在线查询 | 文件/目录级，依赖 Git 历史 | `dvc gc` 按引用范围清理 | 中等 | 不适合在线记录筛选和分支版本 |
| Langfuse temporal rows | 只写变化 Dataset Item | 与累计变化数相关，不复制完整 dataset | 时间区间查询；索引可支持 | 单项历史清楚，显式分支不足 | 删除标记；物理策略另管 | 低到中 | 最适合借鉴稀疏行修订，不可原样照搬分支模型 |
| 推荐的 EvalBase 混合方案 | `D` 条记录操作 + 小 manifest | `O(累计 D + 周期 N)` | 最近检查点 + 有界 delta 链 | 显式版本 DAG + 记录修订/操作 | tombstone + 可达性 GC | 中等，沿用现有 PG/MinIO | 最佳平衡 |

## 5. 推荐设计

### 5.1 保持不变的语义

- `Test Set Version` 仍是不可变、可浏览、可下载的完整逻辑快照；
- `test_set_version.parent_version_id` 继续表达从哪个版本派生，允许现有分支图；
- `test_case` 是稳定记录身份，`case_revision` 是不可变记录内容修订；
- 修改记录继续通过 `case_revision.parent_revision_id` 和来源字段表达溯源；
- PostgreSQL 继续负责项目、测试集、版本、记录、查询和来源；MinIO 继续负责不可变对象和下载工件；
- 不新增 Redis、消息代理、Dolt、Spark、Parquet 或新的基础服务。

### 5.2 新增稀疏版本变更

用概念表 `version_change` 替代“每个版本一份完整 `version_member`”：

| 字段 | 含义 |
|---|---|
| `version_id` | 产生该变化的不可变版本 |
| `case_id` | 稳定记录身份 |
| `operation` | `upsert`、`delete` 或 `move` |
| `case_revision_id` | add/update 后的新修订；delete/move 可为空 |
| `previous_revision_id` | 客户端编辑时看到的父修订，用于冲突和审计 |
| `position_key` | 仅新增或移动时设置的稳定顺序键 |
| `change_reason` | 已有交互允许时记录修改理由；不扩大 UI |

修改记录时提交该记录的**完整新内容**，而不是字段级 JSON Patch。记录级 upsert 已足够把 `N` 降到 `D`，同时更容易做 schema 校验、hash、幂等与审计，也避免补丁顺序和字段删除语义变复杂。

删除不是物理删除 `case_revision`，而是在子版本写入 `delete` tombstone。未被本版本提及的记录自动继承自父版本。

### 5.3 API 改为操作集

派生版本请求由：

```json
{
  "records": ["完整的 10000 条记录"]
}
```

改为类似：

```json
{
  "baseVersionId": "version_v1",
  "operations": [
    {
      "op": "upsert",
      "caseId": "case_5000",
      "expectedRevisionId": "revision_old",
      "record": {
        "question": "修改后的问题",
        "expectedOutput": "...",
        "metadata": []
      }
    }
  ]
}
```

服务端必须：

1. 验证 `baseVersionId` 就是 URL 指定的父版本；
2. 验证每个被修改记录在父版本解析结果中存在，且 `expectedRevisionId` 匹配；
3. 拒绝同一 `case_id` 在一次请求中出现矛盾操作；
4. 按幂等键和规范化后的 operations 计算请求指纹；
5. 仅为 add/update 新建 `case_revision`，并写入相应 `version_change`；
6. 在同一 PostgreSQL 事务中创建 version、change、审计和幂等记录。

即使当前是单人产品，`expectedRevisionId` 仍有价值：两个浏览器标签页或长时间打开的编辑弹窗可能基于同一旧版本，乐观校验可防止无提示覆盖。

### 5.4 顺序不要继续依赖连续 ordinal

如果用户只修改记录内容，不应重写所有记录的位置。每条测试记录应使用稳定的 `position_key`：

- 普通内容修改不写位置变化；
- 新增记录时在相邻 key 之间分配 key；
- 移动记录时只写被移动记录的新 key；
- key 空间不足时只重排一个局部窗口，或在生成检查点时统一规范化。

这可使用带间隔的整数或简单的可比较小数/字符串实现。当前阶段不需要引入协同编辑算法；单人顺序操作只需保证确定性和唯一性。

### 5.5 周期检查点限制读取放大

纯 delta 链如果无限增长，会把写放大变成读放大。因此保留概念表 `version_checkpoint_member`：

```text
checkpoint version
  -> case_revision_id + position_key × N
  -> child delta × D1
  -> child delta × D2
  -> target delta × D3
```

读取目标版本时：

1. 沿父链找到最近的祖先检查点；
2. 从检查点成员开始；
3. 按祖先到目标的顺序应用 upsert/delete/move；
4. 再做筛选、排序和分页。

建议把以下阈值作为**需要基准测试确认的初始值**，不是产品合同：

- 从最近检查点累计 20 个版本；或
- 累计 change 数超过检查点记录数的 20%；
- 任一条件满足，由现有 Worker 在后台生成新检查点。

检查点只复制成员指针和位置，不复制 `case_revision` 正文；因此即使 10,000 条记录偶尔生成一次检查点，增长也远低于每个版本都写 10,000 条。

### 5.6 MinIO 只保存增量 manifest 和按需工件

每个版本发布时保存一个小型不可变 manifest，例如：

```json
{
  "versionId": "version_v2",
  "parentVersionId": "version_v1",
  "itemCount": 10000,
  "changeCount": 1,
  "changesHash": "sha256:...",
  "commitHash": "sha256:..."
}
```

具体 changes 可以存于 PostgreSQL，MinIO manifest 列出规范化 change hash 和引用；如果恢复合同要求对象存储中自包含，也只需保存本次 `D` 条操作，而不是 `N` 条记录。

完整 CSV、数据与溯源包不再成为“每次发布必写”的对象：

- 首次下载时由解析器按版本流式读取记录并生成；
- 生成过程中同时计算完整 `payload_hash`；
- 以 `(version_id, export_format, payload_hash)` 为键缓存到 MinIO；
- 后续重复下载复用同一不可变对象；
- 删除缓存不影响版本真源，缓存可以重新生成。

如果现有正式版本合同要求发布时立即拥有完整 payload hash，服务端仍可流式遍历解析结果计算 hash。这个步骤还是 `O(N)` 读取，但不会产生 `O(N)` 客户端上传、比较对象和数据库写入。只有该流式 hash 本身经测量成为瓶颈时，才考虑 Dolt 式 Merkle root，把 hash 更新进一步降为 `O(log N)`。

### 5.7 完整读取、筛选和下载

PostgreSQL 解析器可使用递归 CTE 找祖先链，并按离目标版本最近的 change 决定每个 `case_id` 的状态；最近检查点限制递归深度。需要的索引至少包括：

- `version_change(version_id, case_id)`；
- `version_checkpoint_member(checkpoint_version_id, position_key)`；
- `case_revision(id)` 及现有 `case_id` 索引；
- 版本父链索引。

对 10,000 条记录，先实现 SQL resolver 并基准测试即可。不要一开始引入通用缓存系统。如果同一历史版本的复杂筛选反复执行确实变慢，可增加**可丢弃、可重建**的 resolved-members cache；它不是版本真源，也不要求每个版本永久保存。

### 5.8 删除与 GC

需要严格区分：

- 从某个子版本删除记录：写 `delete` change，旧版本仍可读取原记录；
- 测试集版本移入回收站：改变版本可见状态，不立刻删除祖先 delta/checkpoint；
- 完整下载缓存：无引用时可直接重建，最适合优先清理；
- `case_revision`、delta manifest、checkpoint：只有当所有保留版本都不可达时才可物理清理。

特别是中间版本存在仍保留的后代时，后代可能依赖该版本的 delta。永久删除不能直接删掉这些数据。可选策略只有两种：

1. 保留仍被后代引用的内部内容，仅把用户可见节点变为 tombstone；或
2. 删除前先为每个保留后代生成独立检查点，再确认祖先内容不再可达。

第一种更简单，也与 Git/Iceberg/lakeFS 的“引用仍可达就不 GC”一致。实际删除语义涉及既有产品行为，实施前必须在 PRD/ADR 中明确，不能由存储优化暗中改变。

## 6. 修改 1/10,000 条后的推荐数据流

```text
浏览器打开 v1
  -> 分页浏览；编辑状态记录 baseVersionId + caseId + revisionId

用户修改第 5000 条并点击“创建新版本”
  -> 浏览器只提交 1 个 upsert operation

服务端
  -> 校验父版本、旧 revision、容量、来源、幂等
  -> 新建 1 条 case_revision
  -> 新建 v2 版本节点
  -> 新建 1 条 version_change
  -> 写 1 个小型增量 manifest 到 MinIO
  -> PostgreSQL 事务提交

浏览 v2
  -> 从最近检查点解析 v1 状态
  -> 应用 v2 的 1 条 upsert
  -> 返回分页结果

首次下载 v2
  -> 流式解析 10,000 条逻辑快照
  -> 生成 CSV/溯源并计算 hash
  -> 缓存完整下载对象到 MinIO
```

在该路径中，发布写入量与 `D=1` 近似相关；只有完整浏览/下载本来就需要读取完整逻辑快照时，才承担 `O(N)` 成本。

## 7. 迁移建议

不建议把现有历史版本全部重写为 delta。更安全的兼容路径是：

1. 把每个已有版本的 `version_member` 视为 legacy checkpoint，原有 MinIO 完整对象继续保留；
2. 新版本开始写 `version_change`，可从任意 legacy checkpoint/新版本派生；
3. 统一 resolver 同时支持“旧完整成员版本”和“新 delta 版本”；
4. 前端编辑状态改为记录局部 operations，只提交发生变化的记录；
5. 新旧 resolver 在只读影子测试中对同一版本计算相同记录数、顺序和内容 hash；
6. 验证通过后停止为新版本写完整 `version_member` 和完整 MinIO records 对象；
7. 后续再加入 Worker checkpoint 和按需 export cache；
8. 旧数据是否迁移/清理应是独立、可回滚的维护任务，不与在线写路径切换绑在同一发布中。

## 8. 必须验证的基准与不变量

实施前应先建立同一份 10,000 条合成测试集，至少测量：

| 场景 | 必须记录 |
|---|---|
| 修改 1 条并发布 | 请求字节、响应时间、PG 新增行/字节、MinIO 新增字节 |
| 修改 100 条并发布 | 同上，并与 1 条路径比较线性关系 |
| 连续 20 个小版本后打开最新版本 | 首屏、前 100 条、筛选 P95、SQL buffers/rows |
| 从旧版本派生分支 | 内容、顺序、父链、来源、版本图正确性 |
| add/delete/move 混合 | 记录数、稳定身份、顺序和 tombstone 正确性 |
| 检查点前后读取同一版本 | 完整 payload hash、分页、筛选结果完全相同 |
| 首次与重复下载 | 流式内存峰值、生成时间、缓存命中、下载 hash |
| 发布中途取消/失败 | 不出现用户可见半成品，MinIO 暂存对象可清理 |

必须保持的不变量：

- 一个版本解析出的 `(case_id, revision_id, position_key)` 唯一且确定；
- 发布后版本不可原位修改；
- 同一父版本 + 同一规范化 operations + 同一幂等键只得到同一结果；
- 任何检查点或缓存的存在与否都不改变逻辑内容；
- 旧版本、分支版本和下载包的内容与来源可重复验证；
- GC 永远不删除仍被任一保留版本引用的修订、delta 或检查点。

## 9. 最终建议

### 现在应该做

1. 先把本文作为研究证据，不立即改数据库；
2. 在下一版 PRD 中确认“版本仍是完整快照，但物理存储允许增量”这一产品不可见约束；
3. 写 ADR，选择“记录级 sparse delta + bounded checkpoint”，并明确删除/GC 对后代版本的语义；
4. 制作一个仅覆盖 10,000 条、修改 1/100 条、20 级版本链和一次分支的技术 spike；
5. spike 证明读取、筛选、下载和失败回滚后，再拆迁移 Ticket。

### 现在不应该做

- 不用 Dolt 替换 PostgreSQL；
- 不在 MinIO 前增加 lakeFS；
- 不把测试集版本改成 DVC 管理的单个 CSV；
- 不引入 Delta Lake、Iceberg、Parquet、Spark 或新的服务；
- 不直接自研 Prolly Tree；
- 不把字段级 JSON Patch、merge/rebase 或多人并发一起塞进本次存储优化；
- 不删除现有完整版本对象，直到新 resolver、检查点、导出和 GC 都被真实验证。

一句话结论：**保留 PostgreSQL + MinIO，以记录级增量提交消除写放大，以周期检查点控制读放大，以按需缓存消除 MinIO 的版本全量重复；这是当前 EvalBase 在性能、可追溯性和实现风险之间最好的平衡。**
