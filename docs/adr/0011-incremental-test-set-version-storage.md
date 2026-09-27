# 测试集版本采用稀疏 Delta 与关系表 Checkpoint

- Status: Accepted
- Date: 2026-09-18
- Decision role: Project Owner / Sole Developer
- Evidence: [技术方案](../proposals/incremental-test-set-version-storage.md)、[隔离 Spike](../spikes/incremental-test-set-version-storage.md)

EvalBase 继续使用 PostgreSQL + MinIO，但新测试集版本不再为每次少量修改重复保存整版成员和完整 records 对象。用户看到的版本仍是完整、不可变、有序快照；底层以记录级稀疏 Delta 保存普通派生版本，以普通 PostgreSQL 关系表保存周期完整 Checkpoint，并从最近 Checkpoint 回放后续 Delta。该选择在 10,000 条合成记录 Spike 中验证了稀疏写入、`v1` 到 `v20` 的回放、Checkpoint 后继续回放和分支隔离，同时避免引入 DVC、Dolt、lakeFS、数据湖引擎、位图或自研持久树。

## 正式 PostgreSQL schema

现有 `test_case`、`case_revision` 和版本图字段继续保持权威。迁移以加法完成，不重写旧历史：

| 表或字段                          | 正式定义与约束                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_set_version.storage_format` | 非空文本枚举：`legacy_full_v1`、`delta_v1`。迁移时所有既有版本标记为 `legacy_full_v1`；启用切换后的新版本使用 `delta_v1`。                                                                                                                                        |
| `version_change`                  | 一行表示一个 `version_id + case_id` 相对直接父版本的最终净变化；主键为 `(version_id, case_id)`，并唯一约束 `(version_id, position)`。字段固定为 `operation`、`position`、`before_revision_id`、`before_content_hash`、`after_revision_id`、`after_content_hash`。 |
| `version_checkpoint`              | 每个 Checkpoint 版本至多一行，`version_id` 同时为主键并引用 `test_set_version`。字段固定为 `format_version = 1`、`reason`、`retention_class`、`item_count`、`members_hash`、`created_at`。                                                                        |
| `version_checkpoint_member`       | 完整成员指针；主键 `(version_id, position)`，唯一约束 `(version_id, case_id)`，字段为 `case_id` 和 `case_revision_id`，并分别引用 `test_case` 与 `case_revision`。                                                                                                |
| `version_member`                  | 只表示 `legacy_full_v1` 的既有完整成员，不再为新的 `delta_v1` 普通派生版本写入。统一读取模块把它视为旧格式的隐式 Checkpoint。                                                                                                                                     |

迁移后的约束必须等价于以下 PostgreSQL DDL；实现可以按仓库迁移器要求拆成幂等语句，但不得改变字段、枚举或约束语义：

```sql
ALTER TABLE test_set_version
  ADD COLUMN storage_format text NOT NULL DEFAULT 'legacy_full_v1'
  CHECK (storage_format IN ('legacy_full_v1', 'delta_v1'));

CREATE TABLE version_change (
  version_id text NOT NULL REFERENCES test_set_version(id) ON DELETE CASCADE,
  case_id text NOT NULL REFERENCES test_case(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('add', 'update', 'delete')),
  position bigint NOT NULL CHECK (position > 0),
  before_revision_id text REFERENCES case_revision(id) ON DELETE SET NULL,
  before_content_hash text,
  after_revision_id text REFERENCES case_revision(id) ON DELETE RESTRICT,
  after_content_hash text,
  PRIMARY KEY (version_id, case_id),
  UNIQUE (version_id, position),
  CHECK (
    (operation = 'add'
      AND before_revision_id IS NULL AND before_content_hash IS NULL
      AND after_revision_id IS NOT NULL AND after_content_hash ~ '^[0-9a-f]{64}$')
    OR
    (operation = 'update'
      AND before_content_hash ~ '^[0-9a-f]{64}$'
      AND after_revision_id IS NOT NULL AND after_content_hash ~ '^[0-9a-f]{64}$')
    OR
    (operation = 'delete'
      AND before_content_hash ~ '^[0-9a-f]{64}$'
      AND after_revision_id IS NULL AND after_content_hash IS NULL)
  )
);

CREATE TABLE version_checkpoint (
  version_id text PRIMARY KEY REFERENCES test_set_version(id) ON DELETE CASCADE,
  format_version smallint NOT NULL DEFAULT 1 CHECK (format_version = 1),
  reason text NOT NULL CHECK (reason IN ('initial', 'periodic', 'hard_limit', 'deletion_cut')),
  retention_class text NOT NULL CHECK (retention_class IN ('rebuildable', 'required_dependency')),
  item_count integer NOT NULL CHECK (item_count >= 0),
  members_hash text NOT NULL CHECK (members_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'deletion_cut' OR retention_class = 'required_dependency')
);

CREATE TABLE version_checkpoint_member (
  version_id text NOT NULL REFERENCES version_checkpoint(version_id) ON DELETE CASCADE,
  position bigint NOT NULL CHECK (position > 0),
  case_id text NOT NULL REFERENCES test_case(id) ON DELETE RESTRICT,
  case_revision_id text NOT NULL REFERENCES case_revision(id) ON DELETE RESTRICT,
  PRIMARY KEY (version_id, position),
  UNIQUE (version_id, case_id)
);
```

`version_change.operation` 只允许 `add`、`update`、`delete`：

| operation | before                                                 | after                | position               |
| --------- | ------------------------------------------------------ | -------------------- | ---------------------- |
| `add`     | revision/hash 均为空                                   | revision/hash 均非空 | 新增稳定位置           |
| `update`  | 发布时 revision/hash 均非空；删除传播后允许只保留 hash | revision/hash 均非空 | 继承父版本位置         |
| `delete`  | 发布时 revision/hash 均非空；删除传播后允许只保留 hash | revision/hash 均为空 | 被删除记录的父版本位置 |

所有位置均为大于零的 64 位整数。修改不改变位置，删除不复用位置，新增使用当前逻辑快照的最大位置加一；页面序号由解析结果重新连续编号，不是身份。`case_id` 必须属于同一测试集，revision 必须属于该 case，before 必须匹配指定父版本；这些跨表约束在锁定的发布事务中复检。

`version_checkpoint.reason` 只允许 `initial`、`periodic`、`hard_limit`、`deletion_cut`。`retention_class` 只允许 `rebuildable`、`required_dependency`；`deletion_cut` 必须是 `required_dependency`。Checkpoint header、全部成员和 `members_hash` 在一个 PostgreSQL 事务内提交，半成品不可见。`members_hash` 是按 position 排序的 `[position, case_id, case_revision_id]` 元组 RFC 8785 canonical JSON 的 SHA-256。

首个 `delta_v1` 版本把全部记录表示为 `add`，并在自身建立 `initial` Checkpoint。普通派生只写净变化；零变化派生允许没有 `version_change` 行。`payload_hash`、`evidence_hash`、`item_count` 始终描述完整逻辑快照，不得改成 Delta 自身的统计或哈希。

## MinIO Delta manifest v1

`delta_v1` 的 `test_set_version.manifest_object_ref` 指向 UTF-8、无 BOM、RFC 8785 canonical JSON 加末尾 LF 的不可变对象。顶层合同固定为：

```json
{
  "format": "evalbase.test-set-delta-manifest",
  "format_version": 1,
  "version_id": "version-id",
  "test_set_id": "test-set-id",
  "parent_version_id": "parent-version-id",
  "publication_order": 7,
  "generation": 4,
  "branch_number": 1,
  "version_label": "v4-b1",
  "published_at": "2026-09-18T00:00:00.000Z",
  "schema_revision_id": "schema-revision-id",
  "item_count": 10000,
  "payload_hash": "full-logical-snapshot-sha256",
  "evidence_hash": "full-logical-evidence-sha256",
  "changes": [
    {
      "case_id": "case-id",
      "operation": "update",
      "position": 42,
      "before_revision_id": "old-revision-id",
      "before_content_hash": "old-content-sha256",
      "after_revision_id": "new-revision-id",
      "after_content_hash": "new-content-sha256"
    }
  ],
  "new_revisions": [
    {
      "revision_id": "new-revision-id",
      "case_id": "case-id",
      "parent_revision_id": "old-revision-id",
      "input": {},
      "expected_output": {},
      "metadata": [],
      "source_record_ordinal": 42,
      "content_hash": "new-content-sha256",
      "origin_kind": "source_record",
      "origin_ref": {},
      "lineage_fingerprint": "sha256",
      "lineage_level": "record_level"
    }
  ],
  "delta_hash": "sha256",
  "manifest_hash": "sha256"
}
```

`changes` 按 position、case_id 排序；`new_revisions` 按 revision_id 排序。`delta_hash` 是只含 `changes` 与 `new_revisions` 的 canonical JSON 的 SHA-256。`manifest_hash` 是移除自身字段后整个 manifest canonical JSON 的 SHA-256，并与 PostgreSQL `manifest_hash` 一致。`payload_hash` 仍是完整逻辑快照哈希，不能用 `delta_hash` 代替。删除项没有 after revision；新增项没有 before revision。Manifest 只包含本版变化与新修订，不重复未变化正文。

根版本的 `parent_version_id` 为 `null`，主路径版本的 `branch_number` 为 `null`。上述字段以及 change 的 before/after 字段必须始终存在，不适用时写 JSON `null`，不得通过省略字段产生第二种编码。

既有 `legacy_full_v1` manifest 和校验规则保持不变。读取、完整性扫描和删除必须先按 `storage_format` 选择格式，不能用 Delta 规则重新解释或改写旧对象。完整 CSV 与 provenance CSV 继续按选中版本从统一解析器流式生成，可作为可删除缓存写入 MinIO，但缓存不是版本真源。

## Checkpoint 阈值与硬上限

每条分支独立从最近有效 Checkpoint 计算回放成本；累计变化量按其后的全部 `version_change` 行数计算，包括同一 case 在多代重复变化，因为这些行都必须回放。空 Checkpoint 的比例分母按 1 计算。

- **后台触发阈值**：距最近 Checkpoint 达到 20 个 Delta 版本，或累计变化行达到 `ceil(max(checkpoint.item_count, 1) × 20%)`，任一满足即为该版本登记幂等 `periodic` Checkpoint 作业。
- **发布硬上限**：任何可见版本不得需要回放超过 40 个 Delta 版本，或超过 `ceil(max(checkpoint.item_count, 1) × 40%)` 条变化。若本次发布将越界，发布路径必须在该新版本上同步建立 `hard_limit` Checkpoint，经数量、顺序、`payload_hash` 与 `members_hash` 校验后才允许版本可见；失败时整个发布回滚并返回可重试错误。
- 单次大变更即使链很短，只要越过 40% 也直接随新版本建立 Checkpoint。后台作业延迟或 Worker 停止不得突破硬上限。
- Checkpoint 只优化读取，不替代该版本相对直接父版本的 `version_change`，因此来源与修改事实不会因物化而丢失。

阈值是内部常量，不成为用户设置或界面。后续只有基于正式基准且不改变用户语义时才能由新 ADR 调整，不能在单张实现 Ticket 中静默修改。

## 永久删除时切断存储依赖

版本图父边与内容存储依赖是两件事。永久删除或墓碑化中间节点时，父边、标签和发布时间顺序不改挂；内容依赖按以下顺序切断：

1. 锁定删除目标、删除范围及所有第一层存活边界后代，立即 fail-closed 阻断目标的新读取、下载、派生和引用。
2. 对每个从删除范围跨出的第一层存活版本，在删除前的受保护快照上解析完整内容。若该版本尚无能够独立于删除范围读取的 Checkpoint，则在该版本自身建立 `deletion_cut` / `required_dependency` Checkpoint。
3. 校验每个切断 Checkpoint 的成员数、顺序、完整 `payload_hash`、来源所需引用和 `members_hash`；在一个事务内发布全部必要 Checkpoint。任何一个失败都不得开始物理清理。
4. 统一解析器遇到存活边界版本的 Checkpoint 后停止向已删除祖先读取内容，但版本关系图仍可显示原墓碑父节点。
5. 只有所有存活分支都已独立后，才删除目标专属 Delta manifest、导出缓存、`version_change`，并清除无存活内容/来源引用的 revision/blob 正文。若稳定身份或既有外键要求保留最小 revision 行，该行必须清空 input、expected output、Metadata 和 origin 等可恢复内容。仅作为 before 值引用的已删除专属 revision 不得因历史 diff 保留正文；指针应置空或只指向内容已清除的最小墓碑，只保留 operation 与 content hash 摘要，界面不得借此恢复正文。
6. `required_dependency` Checkpoint 只有在所有依赖它的存活后代已有更新的独立 Checkpoint或也被永久删除后才能回收。没有存活后代的整支永久删除不创建切断 Checkpoint。
7. 任一步失败时目标保持不可访问，清理作业幂等重试；不得重新暴露目标，也不得损害未删除后代。

该策略细化但不削弱 [ADR-0008](./0008-controlled-deletion-propagation.md)：共享的当前内容和必要来源受保护，删除对象的专属可恢复正文必须清除。Checkpoint 是内部存储结构，不增加用户确认、等待页面、治理选项或恢复能力。

## Consequences

- 正式实现必须先提供同时读取 `legacy_full_v1`、Delta 和 Checkpoint 的统一内部模块，再启用任何 `delta_v1` 写入。
- 回滚到只认识 `version_member` 的旧程序前，必须先把所有 `delta_v1` 版本兼容物化；否则只能向前修复。
- 发布仍可能为完整 hash、数据核对和大变更执行 O(N) 扫描；本决定只消除少量修改时的主要传输和存储写放大，不承诺所有读取或发布为 O(D)。
- Schema、manifest、阈值、删除切断与双格式读取必须在后续实施 Tickets 中一起覆盖；在删除和兼容路径完成前不得切换正式写入格式。
