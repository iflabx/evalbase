import { canonicalJson, sha256 } from "../src/package/contract.js";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { ArtifactRepository } from "../src/storage/artifacts.js";
import { publishSparseVersion } from "../src/version/publish-sparse.js";
import {
  snapshotPayloadHash,
  type SparseRecord,
} from "../src/version/snapshot-record.js";

const projectId = "ticket37_project";
const testSetId = "ticket37_set";
const baseId = "ticket37_base";
const actorId = "user_owner";
const config = loadConfig();
const db = createPool(config.databaseUrl);
const artifacts = new ArtifactRepository(config.minio);

async function seedBase() {
  const existing = await db.query(
    "SELECT 1 FROM test_set_version WHERE id=$1",
    [baseId],
  );
  if (existing.rowCount) return;
  const records: SparseRecord[] = Array.from({ length: 20 }, (_, index) => ({
    question: `合成问题 ${index + 1}`,
    expectedOutput: `合成答案 ${index + 1}`,
    metadata: [{ key: "用途", value: "37 验收" }],
  }));
  const sourceFile = await artifacts.storeImmutable(
    Buffer.from("question,answer\nsynthetic,only\n"),
    "ticket37-source",
  );
  const manifest = await artifacts.storeImmutable(
    Buffer.from(`${canonicalJson({ versionId: baseId, records })}\n`),
    "ticket37-base",
  );
  const payloadHash = snapshotPayloadHash(records);
  const evidenceHash = sha256(canonicalJson({ sources: [], payloadHash }));
  const manifestHash = sha256(
    canonicalJson({ versionId: baseId, payloadHash, evidenceHash }),
  );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO project (id,name,owner_id,description)
      VALUES ($1,'Ticket 37 删除依赖验收',$2,'仅含合成记录')`,
      [projectId, actorId],
    );
    await client.query(
      `INSERT INTO project_member (project_id,user_id,role)
      VALUES ($1,$2,'owner')`,
      [projectId, actorId],
    );
    await client.query(
      `INSERT INTO data_asset
      (id,project_id,blob_sha256,object_ref,size_bytes,mime_type,file_name,format,status,uploaded_by)
      VALUES ('ticket37_asset',$1,$2,$3,$4,'text/csv','synthetic-source.csv','csv','stored',$5)`,
      [
        projectId,
        sourceFile.sha256,
        sourceFile.objectRef,
        sourceFile.size,
        actorId,
      ],
    );
    await client.query(
      `INSERT INTO source_attribution_revision
      (id,asset_id,source_type,source_name,purpose,responsible_actor,
       responsible_person,license_status,sensitivity)
      VALUES ('ticket37_attribution','ticket37_asset','synthetic',
        '合成验收数据','37 删除验收',$1,'Project Owner','confirmed','non_sensitive')`,
      [actorId],
    );
    await client.query(
      `INSERT INTO test_set
      (id,project_id,name,purpose,owner_id,default_version_id)
      VALUES ($1,$2,'Ticket 37 合成删除分支','恢复回收站版本并删除中间版本',$3,$4)`,
      [testSetId, projectId, actorId, baseId],
    );
    await client.query(
      `INSERT INTO formal_schema_revision
      (id,test_set_id,mode,input_schema,expected_output_schema)
      VALUES ('ticket37_schema',$1,'gold_required','{}','{}')`,
      [testSetId],
    );
    await client.query(
      `INSERT INTO working_draft (id,test_set_id,status,updated_by)
      VALUES ('ticket37_draft',$1,'published',$2)`,
      [testSetId, actorId],
    );
    await client.query(
      `INSERT INTO candidate_snapshot
      (id,draft_id,status,schema_revision_id,attribution_revision_id,item_count,
       payload_hash,evidence_hash,object_ref,sources)
      VALUES ('ticket37_candidate','ticket37_draft','published_as_version',
        'ticket37_schema','ticket37_attribution',20,$1,$2,$3,'[]')`,
      [payloadHash, evidenceHash, manifest.objectRef],
    );
    await client.query(
      `INSERT INTO test_set_version
      (id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,
       evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,
       published_at,publication_order,generation,version_label)
      VALUES ($1,$2,1,'ticket37_candidate','ticket37_schema',$3,$4,$5,$6,
        20,$7,now(),1,1,'v1')`,
      [
        baseId,
        testSetId,
        payloadHash,
        evidenceHash,
        manifestHash,
        manifest.objectRef,
        actorId,
      ],
    );
    for (let index = 1; index <= 20; index++) {
      const record = records[index - 1];
      const caseId = `ticket37_case_${index}`;
      const revisionId = `ticket37_rev_${index}`;
      const contentHash = sha256(canonicalJson(record));
      await client.query(
        "INSERT INTO test_case (id,test_set_id) VALUES ($1,$2)",
        [caseId, testSetId],
      );
      await client.query(
        `INSERT INTO case_revision
        (id,case_id,input,expected_output,metadata,source_record_ordinal,
         content_hash,lineage_fingerprint,origin_kind,origin_ref)
        VALUES ($1,$2,$3,$4,$5,0,$6,$7,'manual',$8)`,
        [
          revisionId,
          caseId,
          { question: record.question },
          { text: record.expectedOutput },
          { entries: record.metadata },
          contentHash,
          sha256(canonicalJson({ source: { kind: "manual" }, contentHash })),
          { kind: "manual" },
        ],
      );
      await client.query(
        "INSERT INTO version_member (version_id,case_revision_id,ordinal) VALUES ($1,$2,$3)",
        [baseId, revisionId, index],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await migrate(config.databaseUrl);
  await artifacts.initialize();
  await seedBase();
  const common = { projectId, testSetId, actorId };
  const changed = (question: string, beforeRevisionId: string) => ({
    operation: "update" as const,
    caseId: "ticket37_case_1",
    beforeRevisionId,
    after: {
      question,
      expectedOutput: "合成答案 1",
      metadata: [{ key: "用途", value: "37 验收" }],
    },
  });
  const middle = await publishSparseVersion(db, artifacts, {
    ...common,
    parentVersionId: baseId,
    idempotencyKey: "ticket37-middle",
    operations: [changed("中间版本专属内容", "ticket37_rev_1")],
  });
  const middleMember = await db.query(
    "SELECT case_revision_id FROM resolve_version_members($1) WHERE case_id='ticket37_case_1'",
    [middle.id],
  );
  const beforeRevisionId = String(middleMember.rows[0].case_revision_id);
  const branch = async (key: string, question: string) =>
    publishSparseVersion(db, artifacts, {
      ...common,
      parentVersionId: middle.id,
      idempotencyKey: key,
      operations: [changed(question, beforeRevisionId)],
    });
  const first = await branch("ticket37-first", "分支甲保留内容");
  const second = await branch("ticket37-second", "分支乙保留内容");
  const recoverable = await branch("ticket37-recoverable", "回收站分支内容");
  const trashId = "ticket37_recoverable_trash";
  await db.query(
    "UPDATE test_set_version SET status='trashed' WHERE id=$1 AND status='published'",
    [recoverable.id],
  );
  await db.query(
    `INSERT INTO test_set_trash_entry
      (id,project_id,test_set_id,type,root_version_id,version_ids,status)
     VALUES ($1,$2,$3,'version_branch',$4,$5::jsonb,'trashed')
     ON CONFLICT (id) DO NOTHING`,
    [
      trashId,
      projectId,
      testSetId,
      recoverable.id,
      JSON.stringify([recoverable.id]),
    ],
  );
  console.log(
    JSON.stringify({
      projectId,
      testSetId,
      baseId,
      middle,
      first,
      second,
      recoverable,
      trashId,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.end());
