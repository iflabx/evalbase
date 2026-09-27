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

const projectId = "ticket3536_project";
const testSetId = "ticket3536_set";
const baseId = "ticket3536_base";
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
  const records: SparseRecord[] = Array.from({ length: 10 }, (_, index) => ({
    question: `合成问题 ${index + 1}`,
    expectedOutput: `合成答案 ${index + 1}`,
    metadata: [{ key: "用途", value: "35+36 验收" }],
  }));
  const sourceFile = await artifacts.storeImmutable(
    Buffer.from("question,answer\nsynthetic,only\n"),
    "ticket3536-source",
  );
  const manifest = await artifacts.storeImmutable(
    Buffer.from(`${canonicalJson({ versionId: baseId, records })}\n`),
    "ticket3536-base",
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
      VALUES ($1,'Ticket 35+36 增量与 Checkpoint 验收',$2,'仅含合成记录')`,
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
      VALUES ('ticket3536_asset',$1,$2,$3,$4,'text/csv','synthetic-source.csv','csv','stored',$5)`,
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
      VALUES ('ticket3536_attribution','ticket3536_asset','synthetic',
        '合成验收数据','35+36 功能验收',$1,'Project Owner','confirmed','non_sensitive')`,
      [actorId],
    );
    await client.query(
      `INSERT INTO test_set
      (id,project_id,name,purpose,owner_id,default_version_id)
      VALUES ($1,$2,'Ticket 35+36 合成版本链','查看 Delta、Checkpoint 与后继',$3,$4)`,
      [testSetId, projectId, actorId, baseId],
    );
    await client.query(
      `INSERT INTO formal_schema_revision
      (id,test_set_id,mode,input_schema,expected_output_schema)
      VALUES ('ticket3536_schema',$1,'gold_required','{}','{}')`,
      [testSetId],
    );
    await client.query(
      `INSERT INTO working_draft (id,test_set_id,status,updated_by)
      VALUES ('ticket3536_draft',$1,'published',$2)`,
      [testSetId, actorId],
    );
    await client.query(
      `INSERT INTO candidate_snapshot
      (id,draft_id,status,schema_revision_id,attribution_revision_id,item_count,
       payload_hash,evidence_hash,object_ref,sources)
      VALUES ('ticket3536_candidate','ticket3536_draft','published_as_version',
        'ticket3536_schema','ticket3536_attribution',10,$1,$2,$3,'[]')`,
      [payloadHash, evidenceHash, manifest.objectRef],
    );
    await client.query(
      `INSERT INTO test_set_version
      (id,test_set_id,sequence,candidate_id,schema_revision_id,payload_hash,
       evidence_hash,manifest_hash,manifest_object_ref,item_count,published_by,
       published_at,publication_order,generation,version_label)
      VALUES ($1,$2,1,'ticket3536_candidate','ticket3536_schema',$3,$4,$5,$6,
        10,$7,now(),1,1,'v1')`,
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
    for (let index = 1; index <= 10; index++) {
      const record = records[index - 1];
      const caseId = `ticket3536_case_${index}`;
      const revisionId = `ticket3536_rev_${index}`;
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
  const changed = (index: number) => ({
    operation: "update" as const,
    caseId: `ticket3536_case_${index}`,
    beforeRevisionId: `ticket3536_rev_${index}`,
    after: {
      question: `合成问题 ${index}（已更新）`,
      expectedOutput: `合成答案 ${index}`,
      metadata: [{ key: "用途", value: "35+36 验收" }],
    },
  });
  const delta = await publishSparseVersion(db, artifacts, {
    ...common,
    parentVersionId: baseId,
    idempotencyKey: "ticket3536-delta",
    operations: [changed(1)],
  });
  const checkpoint = await publishSparseVersion(db, artifacts, {
    ...common,
    parentVersionId: delta.id,
    idempotencyKey: "ticket3536-hard",
    operations: [2, 3, 4, 5].map(changed),
  });
  const successor = await publishSparseVersion(db, artifacts, {
    ...common,
    parentVersionId: checkpoint.id,
    idempotencyKey: "ticket3536-successor",
    operations: [],
  });
  const periodic = await publishSparseVersion(db, artifacts, {
    ...common,
    parentVersionId: baseId,
    idempotencyKey: "ticket3536-periodic",
    operations: [changed(6), changed(7)],
  });
  console.log(
    JSON.stringify({
      projectId,
      testSetId,
      baseId,
      delta: delta.id,
      checkpoint: checkpoint.id,
      successor: successor.id,
      periodic: periodic.id,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.end());
