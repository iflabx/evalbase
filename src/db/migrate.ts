import { loadConfig } from "../config.js";
import { createPool } from "./pool.js";
import { canonicalJson, sha256 } from "../package/contract.js";
import type { PoolClient } from "pg";

export const migrationSql = `
CREATE TABLE IF NOT EXISTS schema_migration (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_user (
  id text PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS avatar_color text NOT NULL DEFAULT '#6366f1';
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user ADD CONSTRAINT app_user_role_check
  CHECK (role IN ('admin', 'user', 'owner', 'editor', 'viewer'));
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email_unique
  ON app_user (lower(email)) WHERE email IS NOT NULL;
CREATE TABLE IF NOT EXISTS installation_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  initialized_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  name text NOT NULL,
  owner_id text NOT NULL REFERENCES app_user(id),
  description text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE project ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS project_member (
  project_id text NOT NULL REFERENCES project(id),
  user_id text NOT NULL REFERENCES app_user(id),
  role text NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
ALTER TABLE project_member DROP CONSTRAINT IF EXISTS project_member_role_check;
ALTER TABLE project_member ADD CONSTRAINT project_member_role_check
  CHECK (role IN ('owner', 'editor', 'viewer'));
CREATE TABLE IF NOT EXISTS app_session (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_user(id),
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS project_invitation (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  target_user_id text NOT NULL REFERENCES app_user(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  invited_by text NOT NULL REFERENCES app_user(id),
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS project_invitation_one_pending
  ON project_invitation (project_id, target_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS project_invitation_target_status
  ON project_invitation (target_user_id, status, expires_at);
CREATE TABLE IF NOT EXISTS upload_idempotency (
  project_id text NOT NULL REFERENCES project(id),
  actor_id text NOT NULL REFERENCES app_user(id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  idempotency_key_digest text,
  status text NOT NULL CHECK (status IN ('receiving', 'committed', 'failed')),
  request_fingerprint text,
  asset_id text,
  operation_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_id, operation, idempotency_key)
);
CREATE TABLE IF NOT EXISTS pending_upload (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES app_user(id),
  file_name text NOT NULL,
  mime_type text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'json', 'jsonl')),
  blob_sha256 text NOT NULL,
  object_ref text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('previewable', 'cancelled', 'confirmed', 'expired')),
  display_mapping jsonb,
  parse_summary jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_upload_project_actor_idx
  ON pending_upload (project_id, actor_id, status, expires_at);
CREATE TABLE IF NOT EXISTS confirmed_upload_batch (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES app_user(id),
  idempotency_key text NOT NULL,
  collection_id text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_id, idempotency_key)
);
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS actor_id text REFERENCES app_user(id);
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS operation text;
UPDATE upload_idempotency ui SET actor_id = p.owner_id
FROM project p WHERE ui.project_id = p.id AND ui.actor_id IS NULL;
UPDATE upload_idempotency SET operation = 'asset_upload' WHERE operation IS NULL;
ALTER TABLE upload_idempotency ALTER COLUMN actor_id SET NOT NULL;
ALTER TABLE upload_idempotency ALTER COLUMN operation SET NOT NULL;
ALTER TABLE upload_idempotency DROP CONSTRAINT IF EXISTS upload_idempotency_pkey;
ALTER TABLE upload_idempotency ADD CONSTRAINT upload_idempotency_pkey
  PRIMARY KEY (project_id, actor_id, operation, idempotency_key);
CREATE TABLE IF NOT EXISTS data_asset (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  blob_sha256 text NOT NULL,
  object_ref text NOT NULL,
  size_bytes bigint NOT NULL,
  mime_type text NOT NULL,
  file_name text NOT NULL,
  format text NOT NULL CHECK (format IN ('csv', 'json', 'jsonl')),
  status text NOT NULL CHECK (status IN ('stored', 'archived')),
  uploaded_by text NOT NULL REFERENCES app_user(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE data_asset ADD COLUMN IF NOT EXISTS collection_id text;
CREATE TABLE IF NOT EXISTS raw_material_collection (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  is_unfiled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name),
  UNIQUE (id, project_id),
  CHECK (length(btrim(name)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS raw_material_collection_one_unfiled
  ON raw_material_collection (project_id) WHERE is_unfiled;
CREATE INDEX IF NOT EXISTS raw_material_collection_project_updated_idx
  ON raw_material_collection (project_id, updated_at DESC, id DESC);
INSERT INTO raw_material_collection
  (id, project_id, name, description, is_unfiled)
SELECT 'collection_' || replace(gen_random_uuid()::text, '-', ''),
       p.id, '未整理', '暂时不归入资料集合的文件。', true
FROM project p
ON CONFLICT (project_id, name) DO NOTHING;
UPDATE data_asset da
SET collection_id = collection.id
FROM raw_material_collection collection
WHERE collection.project_id = da.project_id
  AND collection.is_unfiled
  AND da.collection_id IS NULL;
ALTER TABLE data_asset DROP CONSTRAINT IF EXISTS data_asset_collection_project_fkey;
ALTER TABLE data_asset
  ADD CONSTRAINT data_asset_collection_project_fkey
  FOREIGN KEY (collection_id, project_id)
  REFERENCES raw_material_collection (id, project_id);
ALTER TABLE data_asset ALTER COLUMN collection_id SET NOT NULL;
CREATE OR REPLACE FUNCTION agentbench_create_unfiled_collection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO raw_material_collection
    (id, project_id, name, description, is_unfiled)
  VALUES
    ('collection_' || replace(gen_random_uuid()::text, '-', ''),
     NEW.id, '未整理', '暂时不归入资料集合的文件。', true)
  ON CONFLICT (project_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS raw_material_project_unfiled ON project;
CREATE TRIGGER raw_material_project_unfiled
  AFTER INSERT ON project
  FOR EACH ROW EXECUTE FUNCTION agentbench_create_unfiled_collection();
CREATE OR REPLACE FUNCTION agentbench_touch_project_from_collection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE project SET updated_at = now() WHERE id = OLD.project_id;
    RETURN OLD;
  END IF;
  UPDATE project SET updated_at = now() WHERE id = NEW.project_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS raw_material_collection_touch_project ON raw_material_collection;
CREATE TRIGGER raw_material_collection_touch_project
  AFTER INSERT OR UPDATE ON raw_material_collection
  FOR EACH ROW EXECUTE FUNCTION agentbench_touch_project_from_collection();
CREATE OR REPLACE FUNCTION agentbench_default_asset_collection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.collection_id IS NULL THEN
    SELECT id INTO NEW.collection_id
    FROM raw_material_collection
    WHERE project_id = NEW.project_id AND is_unfiled
    LIMIT 1;
  END IF;
  IF NEW.collection_id IS NULL THEN
    RAISE EXCEPTION 'project has no Unfiled collection';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS data_asset_default_collection ON data_asset;
CREATE TRIGGER data_asset_default_collection
  BEFORE INSERT OR UPDATE OF project_id, collection_id ON data_asset
  FOR EACH ROW EXECUTE FUNCTION agentbench_default_asset_collection();
CREATE OR REPLACE FUNCTION agentbench_touch_material_collection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE raw_material_collection SET updated_at = now()
    WHERE id = NEW.collection_id AND project_id = NEW.project_id;
  ELSIF OLD.collection_id IS DISTINCT FROM NEW.collection_id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id THEN
    UPDATE raw_material_collection SET updated_at = now()
    WHERE id = OLD.collection_id AND project_id = OLD.project_id;
    UPDATE raw_material_collection SET updated_at = now()
    WHERE id = NEW.collection_id AND project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS data_asset_touch_collection ON data_asset;
CREATE TRIGGER data_asset_touch_collection
  AFTER INSERT OR UPDATE OF project_id, collection_id ON data_asset
  FOR EACH ROW EXECUTE FUNCTION agentbench_touch_material_collection();
ALTER TABLE data_asset ADD COLUMN IF NOT EXISTS asset_kind text NOT NULL DEFAULT 'raw';
ALTER TABLE data_asset DROP CONSTRAINT IF EXISTS data_asset_asset_kind_check;
ALTER TABLE data_asset ADD CONSTRAINT data_asset_asset_kind_check
  CHECK (asset_kind IN ('raw', 'derived'));
ALTER TABLE data_asset ADD COLUMN IF NOT EXISTS format text;
UPDATE data_asset SET format = CASE
  WHEN lower(file_name) LIKE '%.jsonl' THEN 'jsonl'
  WHEN lower(file_name) LIKE '%.json' THEN 'json'
  ELSE 'csv'
END WHERE format IS NULL;
ALTER TABLE data_asset ALTER COLUMN format SET NOT NULL;
CREATE INDEX IF NOT EXISTS data_asset_project_uploaded_idx
  ON data_asset (project_id, uploaded_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS source_attribution_revision (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES data_asset(id),
  source_type text NOT NULL,
  source_name text NOT NULL,
  purpose text NOT NULL,
  responsible_actor text NOT NULL,
  responsible_person text NOT NULL,
  license_status text NOT NULL,
  sensitivity text NOT NULL,
  source_address text,
  acquired_at timestamptz,
  deidentification_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE source_attribution_revision ADD COLUMN IF NOT EXISTS responsible_person text;
UPDATE source_attribution_revision SET responsible_person = responsible_actor
  WHERE responsible_person IS NULL;
ALTER TABLE source_attribution_revision ALTER COLUMN responsible_person SET NOT NULL;
ALTER TABLE source_attribution_revision ADD COLUMN IF NOT EXISTS source_address text;
ALTER TABLE source_attribution_revision ADD COLUMN IF NOT EXISTS acquired_at timestamptz;
ALTER TABLE source_attribution_revision ADD COLUMN IF NOT EXISTS deidentification_confirmed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS source_attribution_revision_asset_revision_idx
  ON source_attribution_revision (asset_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS source_attribution_revision_source_name_idx
  ON source_attribution_revision (source_name, asset_id);
CREATE TABLE IF NOT EXISTS audit_event (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  actor_id text NOT NULL REFERENCES app_user(id),
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_event_project_time_idx
  ON audit_event (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_event_project_object_idx
  ON audit_event (project_id, object_type, object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_event_project_action_idx
  ON audit_event (project_id, action, created_at DESC);
CREATE TABLE IF NOT EXISTS consistency_finding (
  id bigserial PRIMARY KEY,
  project_id text REFERENCES project(id),
  error_code text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (error_code, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS consistency_finding_open_project_idx
  ON consistency_finding (project_id, status, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS parsed_view (
  id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES data_asset(id),
  format text NOT NULL CHECK (format IN ('csv', 'json', 'jsonl')),
  parser_name text NOT NULL,
  parser_version text NOT NULL,
  parser_config jsonb NOT NULL,
  parser_config_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'parsing', 'ready', 'parse_failed', 'superseded')),
  record_count integer,
  success_count integer,
  failure_count integer,
  boundary_trusted boolean,
  draft_eligible boolean,
  is_current boolean NOT NULL DEFAULT false,
  field_summary jsonb,
  error_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE parsed_view DROP CONSTRAINT IF EXISTS parsed_view_asset_id_key;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS parser_config jsonb;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS parser_config_hash text;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS success_count integer;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS failure_count integer;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS boundary_trusted boolean;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS draft_eligible boolean;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS error_summary jsonb;
ALTER TABLE parsed_view ADD COLUMN IF NOT EXISTS display_mapping jsonb NOT NULL DEFAULT '{}';
UPDATE parsed_view SET format = 'csv' WHERE format IS NULL;
UPDATE parsed_view SET parser_config = jsonb_build_object(
  'encoding', 'utf8', 'delimiter', ',', 'headerRow', 1, 'quote', chr(34)
)
  WHERE parser_config IS NULL;
UPDATE parsed_view SET parser_config_hash = 'ticket01-default' WHERE parser_config_hash IS NULL;
UPDATE parsed_view SET success_count = record_count WHERE success_count IS NULL AND record_count IS NOT NULL;
UPDATE parsed_view SET failure_count = 0 WHERE failure_count IS NULL AND record_count IS NOT NULL;
UPDATE parsed_view SET boundary_trusted = (status IN ('ready', 'superseded')) WHERE boundary_trusted IS NULL;
UPDATE parsed_view SET draft_eligible = (status IN ('ready', 'superseded') AND COALESCE(record_count, 0) <= 10000)
  WHERE draft_eligible IS NULL;
UPDATE parsed_view pv SET is_current = true
WHERE pv.id = (
  SELECT newest.id FROM parsed_view newest WHERE newest.asset_id = pv.asset_id
  ORDER BY (newest.status = 'ready') DESC, newest.created_at DESC LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM parsed_view current_view WHERE current_view.asset_id = pv.asset_id AND current_view.is_current);
ALTER TABLE parsed_view ALTER COLUMN format SET NOT NULL;
ALTER TABLE parsed_view ALTER COLUMN parser_config SET NOT NULL;
ALTER TABLE parsed_view ALTER COLUMN parser_config_hash SET NOT NULL;
ALTER TABLE parsed_view DROP CONSTRAINT IF EXISTS parsed_view_status_check;
ALTER TABLE parsed_view ADD CONSTRAINT parsed_view_status_check CHECK
  (status IN ('queued', 'parsing', 'ready', 'parse_failed', 'cancelled', 'superseded',
              'deletion_pending', 'tombstoned'));
CREATE UNIQUE INDEX IF NOT EXISTS parsed_view_attempt_identity
  ON parsed_view (asset_id, parser_version, parser_config_hash);
CREATE UNIQUE INDEX IF NOT EXISTS parsed_view_one_current
  ON parsed_view (asset_id) WHERE is_current;
CREATE TABLE IF NOT EXISTS source_record (
  parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  ordinal integer NOT NULL,
  value jsonb,
  locator jsonb NOT NULL,
  record_hash text,
  parse_status text NOT NULL DEFAULT 'valid' CHECK (parse_status IN ('valid', 'invalid')),
  parse_error jsonb,
  PRIMARY KEY (parsed_view_id, ordinal)
);
ALTER TABLE source_record ALTER COLUMN value DROP NOT NULL;
ALTER TABLE source_record ALTER COLUMN record_hash DROP NOT NULL;
ALTER TABLE source_record ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'valid';
ALTER TABLE source_record ADD COLUMN IF NOT EXISTS parse_error jsonb;
CREATE TABLE IF NOT EXISTS parsed_view_exclusion (
  parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  locator jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parsed_view_id, locator)
);
CREATE TABLE IF NOT EXISTS job (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  actor_id text NOT NULL REFERENCES app_user(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job DROP CONSTRAINT IF EXISTS job_status_check;
ALTER TABLE job ADD CONSTRAINT job_status_check CHECK
  (status IN ('queued', 'running', 'retry_wait', 'failed', 'cancel_requested',
             'cancelled', 'succeeded'));
ALTER TABLE job ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'queued';
ALTER TABLE job ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS counts jsonb NOT NULL DEFAULT '{}';
ALTER TABLE job ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE job ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3;
ALTER TABLE job ADD COLUMN IF NOT EXISTS next_run_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE job ALTER COLUMN next_run_at DROP NOT NULL;
ALTER TABLE job ADD COLUMN IF NOT EXISTS lease_owner text;
CREATE TABLE IF NOT EXISTS job_stage_duration (
  job_id text NOT NULL,
  kind text NOT NULL,
  stage text NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  observed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE job_stage_duration
  DROP CONSTRAINT IF EXISTS job_stage_duration_job_id_fkey;
CREATE INDEX IF NOT EXISTS job_stage_duration_metric_idx
  ON job_stage_duration (kind, stage);
ALTER TABLE job ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE job ADD COLUMN IF NOT EXISTS retryable boolean;
UPDATE job SET correlation_id = id WHERE correlation_id IS NULL;
ALTER TABLE job ALTER COLUMN correlation_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS job_queued_due
  ON job (next_run_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS job_running_lease
  ON job (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS job_retry_due
  ON job (next_run_at) WHERE status = 'retry_wait';
CREATE TABLE IF NOT EXISTS test_set (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  name text NOT NULL,
  purpose text NOT NULL,
  owner_id text NOT NULL REFERENCES app_user(id),
  default_version_id text,
  status text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_set_project_created_idx
  ON test_set (project_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS formal_schema_revision (
  id text PRIMARY KEY,
  test_set_id text NOT NULL REFERENCES test_set(id),
  dialect text NOT NULL DEFAULT 'https://json-schema.org/draft/2020-12/schema',
  mode text NOT NULL CHECK (mode = 'gold_required'),
  input_schema jsonb NOT NULL,
  expected_output_schema jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE formal_schema_revision ADD COLUMN IF NOT EXISTS dialect text
  NOT NULL DEFAULT 'https://json-schema.org/draft/2020-12/schema';
ALTER TABLE formal_schema_revision DROP CONSTRAINT IF EXISTS formal_schema_revision_mode_check;
ALTER TABLE formal_schema_revision ADD CONSTRAINT formal_schema_revision_mode_check
  CHECK (mode IN ('gold_required', 'input_only'));
CREATE TABLE IF NOT EXISTS working_draft (
  id text PRIMARY KEY,
  test_set_id text UNIQUE NOT NULL REFERENCES test_set(id),
  asset_id text NOT NULL REFERENCES data_asset(id),
  parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  status text NOT NULL CHECK (status IN ('editing', 'materializing', 'published')),
  recipe jsonb,
  formal_schema_id text REFERENCES formal_schema_revision(id),
  updated_by text NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS draft_source (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  asset_id text NOT NULL REFERENCES data_asset(id),
  parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  position integer NOT NULL CHECK (position > 0),
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, position),
  UNIQUE (draft_id, asset_id)
);
CREATE TABLE IF NOT EXISTS candidate_snapshot (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  status text NOT NULL CHECK (status IN ('materializing', 'ready_to_publish', 'publishing', 'published_as_version', 'failed')),
  asset_id text REFERENCES data_asset(id),
  parsed_view_id text REFERENCES parsed_view(id),
  schema_revision_id text REFERENCES formal_schema_revision(id),
  attribution_revision_id text REFERENCES source_attribution_revision(id),
  recipe jsonb,
  item_count integer,
  payload_hash text,
  evidence_hash text,
  validation_report jsonb,
  object_ref text,
  evidence_object_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transformation_run (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  status text NOT NULL CHECK (status IN ('complete', 'incomplete')),
  operation_type text NOT NULL,
  lineage_level text NOT NULL CHECK (lineage_level IN ('record_level', 'asset_level')),
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  validation_report jsonb NOT NULL,
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS transformation_run_input (
  run_id text NOT NULL REFERENCES transformation_run(id),
  object_type text NOT NULL CHECK (object_type IN ('data_asset', 'test_set_version')),
  object_id text NOT NULL,
  sha256 text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, object_type, object_id)
);
ALTER TABLE transformation_run_input ADD COLUMN IF NOT EXISTS sha256 text;
UPDATE transformation_run_input SET sha256 = 'legacy-unhashed-input' WHERE sha256 IS NULL;
ALTER TABLE transformation_run_input ALTER COLUMN sha256 SET NOT NULL;
CREATE TABLE IF NOT EXISTS transformation_run_output (
  run_id text PRIMARY KEY REFERENCES transformation_run(id),
  project_id text NOT NULL REFERENCES project(id),
  asset_id text NOT NULL UNIQUE REFERENCES data_asset(id),
  sha256 text NOT NULL,
  record_count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS transformation_record_edge (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES transformation_run(id),
  output_parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  output_ordinal integer NOT NULL CHECK (output_ordinal > 0),
  input_type text NOT NULL CHECK (input_type IN ('source_record', 'case_revision')),
  input_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, output_ordinal, input_ref)
);
CREATE TABLE IF NOT EXISTS candidate_transformation_run (
  candidate_id text NOT NULL REFERENCES candidate_snapshot(id),
  run_id text NOT NULL REFERENCES transformation_run(id),
  evidence jsonb NOT NULL,
  manifest_hash text NOT NULL,
  PRIMARY KEY (candidate_id, run_id)
);
CREATE TABLE IF NOT EXISTS transformation_run_annotation (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES transformation_run(id),
  note text NOT NULL,
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE candidate_snapshot DROP CONSTRAINT IF EXISTS candidate_snapshot_status_check;
ALTER TABLE candidate_snapshot ADD CONSTRAINT candidate_snapshot_status_check CHECK
  (status IN ('materializing', 'ready_to_publish', 'publishing', 'publish_failed',
             'published_as_version', 'failed', 'superseded', 'deletion_pending',
             'tombstoned'));
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS asset_id text REFERENCES data_asset(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS parsed_view_id text REFERENCES parsed_view(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS schema_revision_id text REFERENCES formal_schema_revision(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS attribution_revision_id text REFERENCES source_attribution_revision(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS recipe jsonb;
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS evidence_object_ref text;
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS sources jsonb;
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS change_note text;
CREATE TABLE IF NOT EXISTS draft_case_binding (
  test_set_id text NOT NULL REFERENCES test_set(id),
  draft_source_id text NOT NULL REFERENCES working_draft(id),
  source_id text NOT NULL REFERENCES draft_source(id),
  source_record_ordinal integer NOT NULL,
  output_slot text NOT NULL,
  case_id text UNIQUE NOT NULL,
  PRIMARY KEY (test_set_id, source_id, source_record_ordinal, output_slot)
);
INSERT INTO draft_source (id, draft_id, asset_id, parsed_view_id, position, created_by)
SELECT 'draftsrc_' || replace(gen_random_uuid()::text, '-', ''),
       wd.id, wd.asset_id, wd.parsed_view_id, 1, wd.updated_by
FROM working_draft wd
WHERE wd.asset_id IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE draft_case_binding ADD COLUMN IF NOT EXISTS source_id text REFERENCES draft_source(id);
UPDATE draft_case_binding binding
SET source_id = source.id
FROM working_draft draft
JOIN draft_source source ON source.draft_id = draft.id AND source.position = 1
WHERE binding.draft_source_id = draft.id
  AND draft.test_set_id = binding.test_set_id
  AND binding.source_id IS NULL;
ALTER TABLE draft_case_binding ALTER COLUMN source_id SET NOT NULL;
ALTER TABLE draft_case_binding DROP CONSTRAINT IF EXISTS draft_case_binding_pkey;
ALTER TABLE draft_case_binding ADD CONSTRAINT draft_case_binding_pkey
  PRIMARY KEY (test_set_id, source_id, source_record_ordinal, output_slot);
CREATE TABLE IF NOT EXISTS candidate_item (
  candidate_id text NOT NULL REFERENCES candidate_snapshot(id),
  ordinal integer NOT NULL,
  case_id text NOT NULL,
  source_record_ordinal integer NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY (candidate_id, ordinal),
  UNIQUE (candidate_id, case_id)
);
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS draft_source_id text REFERENCES draft_source(id);
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS parsed_view_id text REFERENCES parsed_view(id);
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'source_record';
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS manual_reason text;
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS origin_ref jsonb;
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS lineage_fingerprint text;
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS lineage_level text NOT NULL DEFAULT 'record_level';
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS transformation_run_id text REFERENCES transformation_run(id);
CREATE TABLE IF NOT EXISTS test_case (
  id text PRIMARY KEY,
  test_set_id text NOT NULL REFERENCES test_set(id)
);
CREATE TABLE IF NOT EXISTS case_revision (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES test_case(id),
  input jsonb NOT NULL,
  expected_output jsonb NOT NULL,
  metadata jsonb NOT NULL,
  source_record_ordinal integer NOT NULL,
  content_hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS case_revision_case_id_idx ON case_revision (case_id);
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS parent_revision_id text REFERENCES case_revision(id);
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'source_record';
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS origin_ref jsonb;
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS lineage_fingerprint text;
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS lineage_level text NOT NULL DEFAULT 'record_level';
ALTER TABLE case_revision ADD COLUMN IF NOT EXISTS transformation_run_id text REFERENCES transformation_run(id);
CREATE TABLE IF NOT EXISTS test_set_version (
  id text PRIMARY KEY,
  test_set_id text NOT NULL REFERENCES test_set(id),
  sequence integer NOT NULL,
  candidate_id text UNIQUE NOT NULL REFERENCES candidate_snapshot(id),
  schema_revision_id text NOT NULL REFERENCES formal_schema_revision(id),
  payload_hash text NOT NULL,
  evidence_hash text NOT NULL,
  manifest_hash text NOT NULL,
  manifest_object_ref text NOT NULL,
  item_count integer NOT NULL,
  published_by text NOT NULL REFERENCES app_user(id),
  published_at timestamptz NOT NULL,
  UNIQUE (test_set_id, sequence)
);
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS manifest_object_ref text;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS parent_version_id text REFERENCES test_set_version(id);
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS publication_order integer;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS generation integer;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS branch_number integer;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS version_label text;
UPDATE test_set_version
SET publication_order = sequence,
    generation = sequence,
    version_label = 'v' || sequence::text
WHERE publication_order IS NULL OR generation IS NULL OR version_label IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS test_set_version_publication_order_unique
  ON test_set_version (test_set_id, publication_order);
CREATE UNIQUE INDEX IF NOT EXISTS test_set_version_label_unique
  ON test_set_version (test_set_id, version_label);
DROP INDEX IF EXISTS test_set_version_branch_number_unique;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS change_note text;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published';
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS archived_by text REFERENCES app_user(id);
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS archive_reason text;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS cleanup_object_refs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE test_set_version ADD COLUMN IF NOT EXISTS cleanup_pending boolean NOT NULL DEFAULT false;
ALTER TABLE test_set_version DROP CONSTRAINT IF EXISTS test_set_version_status_check;
ALTER TABLE test_set_version ADD CONSTRAINT test_set_version_status_check
  CHECK (status IN ('published', 'archived', 'degraded_by_deletion', 'trashed',
                    'tombstoned', 'permanently_deleted'));
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS base_version_id text REFERENCES test_set_version(id);
ALTER TABLE candidate_item ADD COLUMN IF NOT EXISTS parent_case_revision_id text REFERENCES case_revision(id);
CREATE TABLE IF NOT EXISTS version_member (
  version_id text NOT NULL REFERENCES test_set_version(id),
  case_revision_id text NOT NULL REFERENCES case_revision(id),
  ordinal integer NOT NULL,
  PRIMARY KEY (version_id, ordinal)
);
ALTER TABLE test_set_version
  ADD COLUMN IF NOT EXISTS storage_format text NOT NULL DEFAULT 'legacy_full_v1';
ALTER TABLE test_set_version
  DROP CONSTRAINT IF EXISTS test_set_version_storage_format_check;
ALTER TABLE test_set_version
  ADD CONSTRAINT test_set_version_storage_format_check
  CHECK (storage_format IN ('legacy_full_v1', 'delta_v1'));
CREATE TABLE IF NOT EXISTS version_change (
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
      AND after_revision_id IS NOT NULL AND after_content_hash IS NOT NULL
      AND after_content_hash ~ '^[0-9a-f]{64}$')
    OR
    (operation = 'update'
      AND before_content_hash IS NOT NULL
      AND before_content_hash ~ '^[0-9a-f]{64}$'
      AND after_revision_id IS NOT NULL AND after_content_hash IS NOT NULL
      AND after_content_hash ~ '^[0-9a-f]{64}$')
    OR
    (operation = 'delete'
      AND before_content_hash IS NOT NULL
      AND before_content_hash ~ '^[0-9a-f]{64}$'
      AND after_revision_id IS NULL AND after_content_hash IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS version_change_case_id_idx
  ON version_change (case_id);
CREATE INDEX IF NOT EXISTS version_change_before_revision_id_idx
  ON version_change (before_revision_id);
CREATE INDEX IF NOT EXISTS version_change_after_revision_id_idx
  ON version_change (after_revision_id);
CREATE TABLE IF NOT EXISTS version_checkpoint (
  version_id text PRIMARY KEY REFERENCES test_set_version(id) ON DELETE CASCADE,
  format_version smallint NOT NULL DEFAULT 1 CHECK (format_version = 1),
  reason text NOT NULL
    CHECK (reason IN ('initial', 'periodic', 'hard_limit', 'deletion_cut')),
  retention_class text NOT NULL
    CHECK (retention_class IN ('rebuildable', 'required_dependency')),
  item_count integer NOT NULL CHECK (item_count >= 0),
  members_hash text NOT NULL CHECK (members_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'deletion_cut' OR retention_class = 'required_dependency')
);
CREATE TABLE IF NOT EXISTS version_checkpoint_member (
  version_id text NOT NULL REFERENCES version_checkpoint(version_id) ON DELETE CASCADE,
  position bigint NOT NULL CHECK (position > 0),
  case_id text NOT NULL REFERENCES test_case(id) ON DELETE RESTRICT,
  case_revision_id text NOT NULL REFERENCES case_revision(id) ON DELETE RESTRICT,
  PRIMARY KEY (version_id, position),
  UNIQUE (version_id, case_id)
);
CREATE INDEX IF NOT EXISTS version_checkpoint_member_case_id_idx
  ON version_checkpoint_member (case_id);
CREATE INDEX IF NOT EXISTS version_checkpoint_member_case_revision_id_idx
  ON version_checkpoint_member (case_revision_id);
CREATE TABLE IF NOT EXISTS version_export_cache (
  version_id text NOT NULL REFERENCES test_set_version(id) ON DELETE CASCADE,
  export_type text NOT NULL CHECK (export_type IN ('data.csv', 'provenance.csv')),
  serializer_version integer NOT NULL,
  evidence_fingerprint text NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  document text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (version_id, export_type, serializer_version, evidence_fingerprint)
);
CREATE TABLE IF NOT EXISTS version_provenance_cut_fact (
  version_id text NOT NULL REFERENCES test_set_version(id) ON DELETE CASCADE,
  case_id text NOT NULL REFERENCES test_case(id) ON DELETE RESTRICT,
  change_type text NOT NULL CHECK (change_type IN ('added', 'removed', 'modified', 'unchanged')),
  changed_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (version_id, case_id)
);
CREATE TABLE IF NOT EXISTS version_provenance_cut_state (
  version_id text PRIMARY KEY REFERENCES test_set_version(id) ON DELETE CASCADE,
  parent_version_id text NOT NULL REFERENCES test_set_version(id),
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION checkpoint_members_hash(checkpoint_version_id text)
RETURNS text LANGUAGE sql STABLE AS $checkpoint_hash$
  SELECT encode(sha256(convert_to(
    '[' || COALESCE(string_agg(
      '[' || m.position::text || ',' || to_json(m.case_id)::text || ',' ||
      to_json(m.case_revision_id)::text || ']', ',' ORDER BY m.position
    ), '') || ']', 'UTF8')), 'hex')
  FROM version_checkpoint_member m
  WHERE m.version_id = checkpoint_version_id;
$checkpoint_hash$;
CREATE OR REPLACE FUNCTION resolve_version_members_internal(
  requested_version_id text,
  allow_unavailable boolean,
  check_count boolean
)
RETURNS TABLE (
  version_id text,
  case_revision_id text,
  ordinal integer,
  case_id text,
  "position" bigint
)
LANGUAGE plpgsql STABLE AS $resolver$
DECLARE
  target_status text;
  target_test_set_id text;
  expected_count integer;
  anchor_id text;
  anchor_depth integer;
  anchor_format text;
  anchor_is_checkpoint boolean;
  actual_count integer;
BEGIN
  SELECT v.status, v.test_set_id, v.item_count
    INTO target_status, target_test_set_id, expected_count
    FROM test_set_version v WHERE v.id = requested_version_id;
  IF NOT FOUND OR
     (NOT allow_unavailable AND target_status IN
       ('tombstoned', 'permanently_deleted', 'degraded_by_deletion')) THEN
    RETURN;
  END IF;

  WITH RECURSIVE ancestors AS (
    SELECT v.id, v.parent_version_id, v.storage_format, v.status, 0 AS depth,
           EXISTS (
             SELECT 1 FROM version_checkpoint cp
              WHERE cp.version_id = v.id
                AND cp.item_count = (
                  SELECT count(*) FROM version_checkpoint_member m
                   WHERE m.version_id = cp.version_id
                )
                AND cp.members_hash = checkpoint_members_hash(cp.version_id)
           ) AS has_checkpoint
      FROM test_set_version v WHERE v.id = requested_version_id
    UNION ALL
    SELECT v.id, v.parent_version_id, v.storage_format, v.status, a.depth + 1,
           EXISTS (
             SELECT 1 FROM version_checkpoint cp
              WHERE cp.version_id = v.id
                AND cp.item_count = (
                  SELECT count(*) FROM version_checkpoint_member m
                   WHERE m.version_id = cp.version_id
                )
                AND cp.members_hash = checkpoint_members_hash(cp.version_id)
           )
      FROM ancestors a JOIN test_set_version v ON v.id = a.parent_version_id
     WHERE a.storage_format = 'delta_v1' AND NOT a.has_checkpoint
       AND a.depth < 10000
  )
  SELECT a.id, a.depth, a.storage_format, a.has_checkpoint
    INTO anchor_id, anchor_depth, anchor_format, anchor_is_checkpoint
    FROM ancestors a
   WHERE a.storage_format = 'legacy_full_v1' OR a.has_checkpoint
   ORDER BY a.depth LIMIT 1;
  IF anchor_id IS NULL THEN
    RAISE EXCEPTION 'version_resolution_base_missing: %', requested_version_id;
  END IF;
  IF NOT allow_unavailable AND EXISTS (
    WITH RECURSIVE path AS (
      SELECT v.id, v.parent_version_id, v.status, v.cleanup_pending, 0 AS depth
        FROM test_set_version v WHERE v.id = requested_version_id
      UNION ALL
      SELECT v.id, v.parent_version_id, v.status, v.cleanup_pending, p.depth + 1
        FROM path p JOIN test_set_version v ON v.id = p.parent_version_id
       WHERE p.depth < anchor_depth
    )
    SELECT 1 FROM path
     WHERE status IN ('permanently_deleted', 'degraded_by_deletion')
        OR (status = 'tombstoned' AND NOT cleanup_pending)
  ) THEN
    RAISE EXCEPTION 'version_resolution_dependency_unavailable: %',
      requested_version_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM version_member vm
    JOIN case_revision cr ON cr.id = vm.case_revision_id
    JOIN test_case tc ON tc.id = cr.case_id
    WHERE vm.version_id = anchor_id AND anchor_format = 'legacy_full_v1'
      AND NOT anchor_is_checkpoint AND tc.test_set_id <> target_test_set_id
  ) OR EXISTS (
    SELECT 1 FROM version_checkpoint_member cm
    JOIN test_case tc ON tc.id = cm.case_id
    JOIN case_revision cr ON cr.id = cm.case_revision_id
    WHERE cm.version_id = anchor_id AND anchor_is_checkpoint
      AND (tc.test_set_id <> target_test_set_id OR cr.case_id <> cm.case_id)
  ) OR EXISTS (
    WITH RECURSIVE path AS (
      SELECT v.id, v.parent_version_id, 0 AS depth
        FROM test_set_version v WHERE v.id = requested_version_id
      UNION ALL
      SELECT v.id, v.parent_version_id, p.depth + 1
        FROM path p JOIN test_set_version v ON v.id = p.parent_version_id
       WHERE p.depth < anchor_depth
    )
    SELECT 1 FROM path p
    JOIN version_change ch ON ch.version_id = p.id
    JOIN test_case tc ON tc.id = ch.case_id
    LEFT JOIN case_revision cr ON cr.id = ch.after_revision_id
    WHERE p.depth < anchor_depth
      AND (tc.test_set_id <> target_test_set_id
        OR (ch.after_revision_id IS NOT NULL AND cr.case_id <> ch.case_id))
  ) THEN
    RAISE EXCEPTION 'version_resolution_cross_test_set_reference: %',
      requested_version_id;
  END IF;

  RETURN QUERY
  WITH RECURSIVE ancestors AS (
    SELECT v.id, v.parent_version_id, 0 AS depth
      FROM test_set_version v WHERE v.id = requested_version_id
    UNION ALL
    SELECT v.id, v.parent_version_id, a.depth + 1
      FROM ancestors a JOIN test_set_version v ON v.id = a.parent_version_id
     WHERE a.depth < anchor_depth
  ),
  candidates AS (
    SELECT cr.case_id, vm.case_revision_id, vm.ordinal::bigint AS position,
           anchor_depth AS layer
      FROM version_member vm
      JOIN case_revision cr ON cr.id = vm.case_revision_id
     WHERE vm.version_id = anchor_id AND anchor_format = 'legacy_full_v1'
       AND NOT anchor_is_checkpoint
    UNION ALL
    SELECT cm.case_id, cm.case_revision_id, cm.position, anchor_depth
      FROM version_checkpoint_member cm
     WHERE cm.version_id = anchor_id AND anchor_is_checkpoint
    UNION ALL
    SELECT ch.case_id, ch.after_revision_id, ch.position, a.depth
      FROM ancestors a JOIN version_change ch ON ch.version_id = a.id
     WHERE a.depth < anchor_depth
  ),
  latest AS (
    SELECT DISTINCT ON (c.case_id) c.case_id, c.case_revision_id, c.position
      FROM candidates c ORDER BY c.case_id, c.layer
  )
  SELECT requested_version_id, live.case_revision_id,
         row_number() OVER (ORDER BY live.position, live.case_id)::integer,
         live.case_id, live.position
    FROM latest live
   WHERE live.case_revision_id IS NOT NULL
   ORDER BY live.position, live.case_id;
  GET DIAGNOSTICS actual_count = ROW_COUNT;
  IF check_count AND actual_count <> expected_count THEN
    RAISE EXCEPTION 'version_resolution_count_mismatch: %', requested_version_id;
  END IF;
END;
$resolver$;
CREATE OR REPLACE FUNCTION resolve_version_members(
  requested_version_id text,
  allow_unavailable boolean DEFAULT false
)
RETURNS TABLE (
  version_id text,
  case_revision_id text,
  ordinal integer,
  case_id text,
  "position" bigint
)
LANGUAGE sql STABLE AS $resolver$
  SELECT * FROM resolve_version_members_internal(requested_version_id, allow_unavailable, true);
$resolver$;
CREATE OR REPLACE VIEW resolved_version_member AS
  SELECT member.version_id, member.case_revision_id, member.ordinal,
         member.case_id, member.position
    FROM test_set_version v
    CROSS JOIN LATERAL resolve_version_members(v.id) member;
CREATE TABLE IF NOT EXISTS delivery_record (
  id text PRIMARY KEY,
  version_id text UNIQUE NOT NULL REFERENCES test_set_version(id),
  target_type text NOT NULL,
  object_ref text NOT NULL,
  delivery_hash text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS project_id text REFERENCES project(id);
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS package_type text;
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS package_format_version text;
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS created_by text REFERENCES app_user(id);
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS downloaded_at timestamptz;
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS confirmed_by text REFERENCES app_user(id);
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS external_copy_recorded boolean NOT NULL DEFAULT false;
UPDATE delivery_record dr
SET project_id = ts.project_id,
    package_type = 'standard',
    package_format_version = '1.0',
    created_by = v.published_by
FROM test_set_version v
JOIN test_set ts ON ts.id = v.test_set_id
WHERE dr.version_id = v.id
  AND (dr.project_id IS NULL OR dr.package_type IS NULL OR dr.created_by IS NULL);
DELETE FROM delivery_record legacy
USING delivery_record replacement
WHERE legacy.target_type = 'standard_package'
  AND legacy.package_type = 'standard_package'
  AND replacement.version_id = legacy.version_id
  AND replacement.package_type = 'standard';
UPDATE delivery_record
SET package_type = 'standard'
WHERE target_type = 'standard_package' AND package_type = 'standard_package';
ALTER TABLE delivery_record ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE delivery_record ALTER COLUMN package_type SET NOT NULL;
ALTER TABLE delivery_record ALTER COLUMN package_format_version SET NOT NULL;
ALTER TABLE delivery_record DROP CONSTRAINT IF EXISTS delivery_record_version_id_key;
ALTER TABLE delivery_record DROP CONSTRAINT IF EXISTS delivery_record_target_type_check;
ALTER TABLE delivery_record ADD CONSTRAINT delivery_record_target_type_check
  CHECK (target_type IN ('standard_package', 'full_provenance_package', 'langfuse_csv'));
ALTER TABLE delivery_record DROP CONSTRAINT IF EXISTS delivery_record_status_check;
ALTER TABLE delivery_record ADD CONSTRAINT delivery_record_status_check
  CHECK (status IN ('generated', 'downloaded', 'user_confirmed_imported',
                    'deletion_pending', 'tombstoned'));
CREATE UNIQUE INDEX IF NOT EXISTS delivery_logical_artifact
  ON delivery_record (version_id, package_type, package_format_version);
ALTER TABLE working_draft DROP CONSTRAINT IF EXISTS working_draft_test_set_id_key;
ALTER TABLE working_draft ALTER COLUMN asset_id DROP NOT NULL;
ALTER TABLE working_draft ALTER COLUMN parsed_view_id DROP NOT NULL;
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS base_version_id text REFERENCES test_set_version(id);
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS lease_holder_id text REFERENCES app_user(id);
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS version_description text NOT NULL DEFAULT '';
ALTER TABLE working_draft DROP CONSTRAINT IF EXISTS working_draft_status_check;
ALTER TABLE working_draft ADD CONSTRAINT working_draft_status_check CHECK
  (status IN ('editing', 'materializing', 'published', 'abandoned'));
CREATE UNIQUE INDEX IF NOT EXISTS working_draft_one_active
  ON working_draft (test_set_id) WHERE status IN ('editing', 'materializing');
CREATE TABLE IF NOT EXISTS mapping_revision (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  mapping jsonb NOT NULL,
  unmapped_fields jsonb NOT NULL,
  unmapped_confirmed boolean NOT NULL,
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE working_draft ADD COLUMN IF NOT EXISTS mapping_revision_id text REFERENCES mapping_revision(id);
CREATE TABLE IF NOT EXISTS formal_schema_proposal (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  mapping_hash text NOT NULL,
  selected_records_hash text NOT NULL,
  scanned_record_count integer NOT NULL,
  suggestion jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE formal_schema_revision ADD COLUMN IF NOT EXISTS proposal_id text REFERENCES formal_schema_proposal(id);
CREATE TABLE IF NOT EXISTS draft_revision (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  revision integer NOT NULL,
  recipe jsonb,
  sources jsonb,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  schema_revision_id text REFERENCES formal_schema_revision(id),
  base_version_id text REFERENCES test_set_version(id),
  version_description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revision_hash text NOT NULL,
  UNIQUE (draft_id, revision)
);
ALTER TABLE draft_revision ADD COLUMN IF NOT EXISTS sources jsonb;
ALTER TABLE draft_revision ADD COLUMN IF NOT EXISTS operations jsonb;
ALTER TABLE draft_revision ADD COLUMN IF NOT EXISTS schema_revision_id text REFERENCES formal_schema_revision(id);
ALTER TABLE draft_revision ADD COLUMN IF NOT EXISTS base_version_id text REFERENCES test_set_version(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS draft_revision_id text REFERENCES draft_revision(id);
ALTER TABLE candidate_snapshot ADD COLUMN IF NOT EXISTS materializer_version text NOT NULL DEFAULT 'candidate-v1';
CREATE UNIQUE INDEX IF NOT EXISTS candidate_snapshot_materialization_key
  ON candidate_snapshot (draft_revision_id, schema_revision_id, materializer_version)
  WHERE draft_revision_id IS NOT NULL AND schema_revision_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS draft_source (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  asset_id text NOT NULL REFERENCES data_asset(id),
  parsed_view_id text NOT NULL REFERENCES parsed_view(id),
  position integer NOT NULL CHECK (position > 0),
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, position),
  UNIQUE (draft_id, asset_id)
);
ALTER TABLE draft_source ADD COLUMN IF NOT EXISTS mapping jsonb;
ALTER TABLE draft_source ADD COLUMN IF NOT EXISTS unmapped_fields jsonb NOT NULL DEFAULT '[]';
ALTER TABLE draft_source ADD COLUMN IF NOT EXISTS unmapped_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE draft_source ADD COLUMN IF NOT EXISTS removed_at timestamptz;
ALTER TABLE draft_source DROP CONSTRAINT IF EXISTS draft_source_draft_id_asset_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS draft_source_one_active_asset
  ON draft_source (draft_id, asset_id) WHERE removed_at IS NULL;
UPDATE draft_source ds
SET mapping = COALESCE(mr.mapping, wd.recipe -> 'mapping'),
    unmapped_fields = COALESCE(mr.unmapped_fields, '[]'::jsonb),
    unmapped_confirmed = COALESCE(mr.unmapped_confirmed, false)
FROM working_draft wd
LEFT JOIN mapping_revision mr ON mr.id = wd.mapping_revision_id
WHERE ds.draft_id = wd.id AND ds.mapping IS NULL;
CREATE TABLE IF NOT EXISTS draft_case_operation (
  id text PRIMARY KEY,
  draft_id text NOT NULL REFERENCES working_draft(id),
  operation text NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  case_id text NOT NULL,
  input jsonb,
  expected_output jsonb,
  metadata jsonb,
  reason text,
  previous_content jsonb,
  diff jsonb,
  created_by text NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, case_id)
);
ALTER TABLE draft_case_operation ADD COLUMN IF NOT EXISTS previous_content jsonb;
ALTER TABLE draft_case_operation ADD COLUMN IF NOT EXISTS diff jsonb;
UPDATE draft_revision dr
SET operations = CASE
  WHEN dr.revision = wd.revision THEN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(op) ORDER BY op.created_at, op.id)
      FROM draft_case_operation op
      WHERE op.draft_id = dr.draft_id
    ),
    '[]'::jsonb
  )
  ELSE '[]'::jsonb
END
FROM working_draft wd
WHERE dr.draft_id = wd.id AND dr.operations IS NULL;
ALTER TABLE draft_revision ALTER COLUMN operations SET DEFAULT '[]'::jsonb;
ALTER TABLE draft_revision ALTER COLUMN operations SET NOT NULL;

-- Ticket 14: fail-closed controlled deletion state and non-content evidence.
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS idempotency_key_digest text;
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS deleted_resource_id text;
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS result_kind text;
ALTER TABLE upload_idempotency ADD COLUMN IF NOT EXISTS tombstoned_at timestamptz;
-- Legacy deletions stored the digest in the client-key column. Preserve that
-- digest while moving the primary-key value to an internal tombstone key so a
-- future client key cannot collide with the deleted row.
UPDATE upload_idempotency
SET idempotency_key_digest = idempotency_key,
    idempotency_key = concat('tombstone:legacy:', replace(gen_random_uuid()::text, '-', ''))
WHERE status = 'tombstoned' AND idempotency_key_digest IS NULL;
CREATE INDEX IF NOT EXISTS upload_idempotency_tombstone_digest_idx
  ON upload_idempotency (project_id, actor_id, operation, idempotency_key_digest)
  WHERE status = 'tombstoned';
ALTER TABLE upload_idempotency DROP CONSTRAINT IF EXISTS upload_idempotency_status_check;
ALTER TABLE upload_idempotency ADD CONSTRAINT upload_idempotency_status_check
  CHECK (status IN ('receiving', 'committed', 'failed', 'tombstoned'));

ALTER TABLE data_asset DROP CONSTRAINT IF EXISTS data_asset_status_check;
ALTER TABLE data_asset ADD CONSTRAINT data_asset_status_check
  CHECK (status IN ('stored', 'archived', 'deletion_pending', 'tombstoned'));

ALTER TABLE parsed_view DROP CONSTRAINT IF EXISTS parsed_view_status_check;
ALTER TABLE parsed_view ADD CONSTRAINT parsed_view_status_check
  CHECK (status IN ('queued', 'parsing', 'ready', 'parse_failed', 'cancelled',
                   'superseded', 'deletion_pending', 'tombstoned'));

ALTER TABLE candidate_snapshot DROP CONSTRAINT IF EXISTS candidate_snapshot_status_check;
ALTER TABLE candidate_snapshot ADD CONSTRAINT candidate_snapshot_status_check
  CHECK (status IN ('materializing', 'ready_to_publish', 'publishing',
                    'publish_failed', 'published_as_version', 'failed',
                    'superseded', 'deletion_pending', 'tombstoned'));

ALTER TABLE test_set_version DROP CONSTRAINT IF EXISTS test_set_version_status_check;
ALTER TABLE test_set_version ADD CONSTRAINT test_set_version_status_check
  CHECK (status IN ('published', 'archived', 'degraded_by_deletion', 'trashed',
                    'tombstoned', 'permanently_deleted'));

ALTER TABLE test_set ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'available';
ALTER TABLE test_set DROP CONSTRAINT IF EXISTS test_set_status_check;
ALTER TABLE test_set ADD CONSTRAINT test_set_status_check
  CHECK (status IN ('available', 'unavailable_by_deletion', 'trashed',
                    'permanently_deleted'));

CREATE TABLE IF NOT EXISTS test_set_trash_entry (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  test_set_id text NOT NULL REFERENCES test_set(id),
  type text NOT NULL CHECK (type IN ('test_set', 'version_branch')),
  root_version_id text REFERENCES test_set_version(id),
  version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  object_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('trashed', 'purging', 'restored', 'permanently_deleted')),
  trashed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS test_set_trash_entry_project_status_idx
  ON test_set_trash_entry (project_id, status, trashed_at DESC, id DESC);

ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS deletion_event_id text;
ALTER TABLE delivery_record ADD COLUMN IF NOT EXISTS external_copy_disposition jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE delivery_record DROP CONSTRAINT IF EXISTS delivery_record_status_check;
ALTER TABLE delivery_record ADD CONSTRAINT delivery_record_status_check
  CHECK (status IN ('generated', 'downloaded', 'user_confirmed_imported',
                    'deletion_pending', 'tombstoned'));

CREATE TABLE IF NOT EXISTS deletion_event (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  target_type text NOT NULL CHECK (target_type IN ('data_asset', 'test_set_version', 'test_set')),
  target_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('preview_ready', 'confirmed', 'running', 'failed', 'completed')),
  stage text NOT NULL DEFAULT 'preview',
  preview_hash text NOT NULL,
  closure jsonb NOT NULL,
  reason_code text,
  reason_note text,
  initiated_by text NOT NULL REFERENCES app_user(id),
  confirmed_by text REFERENCES app_user(id),
  initiated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  failure_message text,
  external_copy_dispositions jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS deletion_event_project_time_idx
  ON deletion_event (project_id, initiated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS deletion_event_target_idx
  ON deletion_event (project_id, target_type, target_id, initiated_at DESC);

CREATE TABLE IF NOT EXISTS deletion_lock (
  event_id text NOT NULL REFERENCES deletion_event(id),
  project_id text NOT NULL REFERENCES project(id),
  object_type text NOT NULL,
  object_id text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_type, object_id)
);
CREATE INDEX IF NOT EXISTS deletion_lock_event_idx
  ON deletion_lock (event_id, project_id);

CREATE TABLE IF NOT EXISTS deletion_tombstone (
  event_id text NOT NULL REFERENCES deletion_event(id),
  object_type text NOT NULL,
  opaque_object_id text NOT NULL,
  prior_hash text,
  affected_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_id text NOT NULL REFERENCES app_user(id),
  reason_code text NOT NULL,
  reason_note text,
  initiated_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL,
  completed_at timestamptz,
  result_status text NOT NULL,
  PRIMARY KEY (event_id, object_type, opaque_object_id)
);
CREATE INDEX IF NOT EXISTS deletion_tombstone_project_idx
  ON deletion_tombstone (actor_id, completed_at DESC, event_id);

-- V2 shared draft workspace. An active parent has one stable draft identity.
CREATE TABLE IF NOT EXISTS collaborative_draft (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id),
  test_set_id text REFERENCES test_set(id),
  parent_version_id text REFERENCES test_set_version(id),
  name text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  name_revision bigint NOT NULL DEFAULT 0,
  purpose_revision bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'editing'
    CHECK (status IN ('editing','published','discarded','terminated')),
  revision bigint NOT NULL DEFAULT 0,
  updated_by text NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES app_user(id),
  created_at timestamptz,
  published_version_id text REFERENCES test_set_version(id),
  CHECK (test_set_id IS NOT NULL OR parent_version_id IS NULL),
  CHECK (status <> 'published' OR published_version_id IS NOT NULL)
);
ALTER TABLE collaborative_draft ADD COLUMN IF NOT EXISTS created_by text REFERENCES app_user(id);
ALTER TABLE collaborative_draft ADD COLUMN IF NOT EXISTS created_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS collaborative_draft_active_parent
  ON collaborative_draft (project_id,test_set_id,parent_version_id)
  WHERE status = 'editing' AND parent_version_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collaborative_draft_published_version
  ON collaborative_draft (published_version_id)
  WHERE published_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS collaborative_draft_project_recent
  ON collaborative_draft (project_id,updated_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS collaborative_draft_record (
  draft_id text NOT NULL REFERENCES collaborative_draft(id) ON DELETE CASCADE,
  id text NOT NULL,
  position bigint NOT NULL CHECK (position > 0),
  case_id text,
  before_revision_id text,
  question text NOT NULL DEFAULT '',
  expected_output text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
  source jsonb,
  deleted boolean NOT NULL DEFAULT false,
  row_revision bigint NOT NULL DEFAULT 0,
  question_revision bigint NOT NULL DEFAULT 0,
  expected_output_revision bigint NOT NULL DEFAULT 0,
  metadata_revision bigint NOT NULL DEFAULT 0,
  source_revision bigint NOT NULL DEFAULT 0,
  field_attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id,id),
  UNIQUE (draft_id,position)
);
CREATE TABLE IF NOT EXISTS collaborative_draft_event (
  draft_id text NOT NULL REFERENCES collaborative_draft(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  project_id text NOT NULL REFERENCES project(id),
  status text NOT NULL,
  changed_by text REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id,revision)
);
CREATE OR REPLACE FUNCTION record_collaborative_draft_event() RETURNS trigger AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    INSERT INTO collaborative_draft_event (draft_id,revision,project_id,status,changed_by)
    VALUES (NEW.id,NEW.revision,NEW.project_id,NEW.status,NEW.updated_by)
    ON CONFLICT (draft_id,revision) DO NOTHING;
    DELETE FROM collaborative_draft_event
    WHERE draft_id=NEW.id AND
      (revision <= NEW.revision - 10000 OR created_at < now() - interval '24 hours');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collaborative_draft_event_written ON collaborative_draft;
CREATE TRIGGER collaborative_draft_event_written
  AFTER UPDATE OF revision ON collaborative_draft FOR EACH ROW
  EXECUTE FUNCTION record_collaborative_draft_event();
CREATE TABLE IF NOT EXISTS collaborative_draft_attribution (
  version_id text NOT NULL REFERENCES test_set_version(id) ON DELETE CASCADE,
  draft_row_id text NOT NULL,
  case_id text NOT NULL REFERENCES test_case(id),
  field_attribution jsonb NOT NULL,
  saved_by text NOT NULL REFERENCES app_user(id),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (version_id,draft_row_id)
);
DROP INDEX IF EXISTS collaborative_draft_source_once;
CREATE UNIQUE INDEX IF NOT EXISTS collaborative_draft_source_active_unique
  ON collaborative_draft_record
  (draft_id,(source->>'assetId'),((source->>'ordinal')::integer))
  WHERE source IS NOT NULL AND deleted = false;
CREATE INDEX IF NOT EXISTS collaborative_draft_record_page
  ON collaborative_draft_record (draft_id,position) WHERE deleted = false;
CREATE OR REPLACE FUNCTION terminate_collaborative_drafts() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'test_set' AND NEW.status = 'permanently_deleted' THEN
    UPDATE collaborative_draft SET status='terminated', name='', purpose='',
      revision=revision+1, updated_at=now() WHERE test_set_id=NEW.id AND status='editing';
  ELSIF TG_TABLE_NAME = 'test_set_version'
    AND NEW.status IN ('permanently_deleted','tombstoned') THEN
    UPDATE collaborative_draft SET status='terminated', name='', purpose='',
      revision=revision+1, updated_at=now() WHERE parent_version_id=NEW.id AND status='editing';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    IF TG_TABLE_NAME = 'test_set' THEN
      UPDATE collaborative_draft SET revision=revision+1, updated_at=now()
        WHERE test_set_id=NEW.id AND status='editing';
    ELSE
      UPDATE collaborative_draft SET revision=revision+1, updated_at=now()
        WHERE parent_version_id=NEW.id AND status='editing';
    END IF;
  END IF;
  DELETE FROM collaborative_draft_record WHERE draft_id IN
    (SELECT id FROM collaborative_draft WHERE status='terminated'
       AND (test_set_id=NEW.id OR parent_version_id=NEW.id));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS collaborative_draft_test_set_termination ON test_set;
CREATE TRIGGER collaborative_draft_test_set_termination
  AFTER UPDATE OF status ON test_set FOR EACH ROW
  EXECUTE FUNCTION terminate_collaborative_drafts();
DROP TRIGGER IF EXISTS collaborative_draft_version_termination ON test_set_version;
CREATE TRIGGER collaborative_draft_version_termination
  AFTER UPDATE OF status ON test_set_version FOR EACH ROW
  EXECUTE FUNCTION terminate_collaborative_drafts();

`;

export const DRAFT_REVISION_OPERATIONS_MIGRATION =
  "ticket07-draft-revision-operations-v3";
export const CASE_REVISION_LINEAGE_MIGRATION =
  "ticket08-case-revision-lineage-v2";
export const CASE_BINDING_EAGER_MIGRATION = "ticket08-case-binding-eager-v1";
export const JOB_COORDINATION_MIGRATION = "ticket09-job-coordination-v1";
export const TRANSFORMATION_LINEAGE_MIGRATION =
  "ticket10-transformation-lineage-v1";

export interface DraftRevisionMigrationRow {
  revision: number | string;
  current_revision: number | string;
  recipe: unknown;
  sources: unknown;
  schema_revision_id: string | null;
  base_version_id: string | null;
  version_description: string;
  revision_hash: string;
}

function legacyRevisionPayload(row: DraftRevisionMigrationRow) {
  return {
    revision: Number(row.revision),
    recipe: row.recipe,
    versionDescription: row.version_description,
    baseVersionId: row.base_version_id ?? null,
    schemaRevisionId: row.schema_revision_id ?? null,
    sources: row.sources,
  };
}

function preMultiAssetRevisionPayload(row: DraftRevisionMigrationRow) {
  return {
    revision: Number(row.revision),
    recipe: row.recipe,
    versionDescription: row.version_description,
  };
}

export function isLegacyDraftRevision(row: DraftRevisionMigrationRow): boolean {
  return (
    row.revision_hash === sha256(canonicalJson(legacyRevisionPayload(row))) ||
    row.revision_hash ===
      sha256(canonicalJson(preMultiAssetRevisionPayload(row)))
  );
}

export function repairedDraftRevision(
  row: DraftRevisionMigrationRow,
  currentOperations: unknown[],
): { operations: unknown[]; revisionHash: string } | undefined {
  if (!isLegacyDraftRevision(row)) return undefined;
  const operations =
    Number(row.revision) === Number(row.current_revision)
      ? currentOperations
      : [];
  return {
    operations,
    revisionHash: sha256(
      canonicalJson({ ...legacyRevisionPayload(row), operations }),
    ),
  };
}

async function repairLegacyDraftRevisions(client: PoolClient): Promise<void> {
  const revisions = await client.query<
    DraftRevisionMigrationRow & { id: string; draft_id: string }
  >(
    `SELECT dr.id, dr.draft_id, dr.revision, dr.recipe, dr.sources,
            dr.schema_revision_id, dr.base_version_id, dr.version_description,
            dr.revision_hash, wd.revision AS current_revision
     FROM draft_revision dr
     JOIN working_draft wd ON wd.id = dr.draft_id
     ORDER BY dr.id`,
  );
  const currentOperations = new Map<string, unknown[]>();
  for (const row of revisions.rows) {
    if (!isLegacyDraftRevision(row)) continue;
    let operations = currentOperations.get(row.draft_id);
    if (!operations) {
      operations = (
        await client.query(
          `SELECT id, draft_id, operation, case_id, input, expected_output,
                  metadata, reason, previous_content, diff, created_by,
                  created_at::text AS created_at
           FROM draft_case_operation
           WHERE draft_id = $1 ORDER BY created_at, id`,
          [row.draft_id],
        )
      ).rows;
      currentOperations.set(row.draft_id, operations);
    }
    const repaired = repairedDraftRevision(row, operations);
    if (!repaired) continue;
    await client.query(
      `UPDATE draft_revision
       SET operations = $1::jsonb, revision_hash = $2
       WHERE id = $3`,
      [JSON.stringify(repaired.operations), repaired.revisionHash, row.id],
    );
  }
}

interface CaseRevisionLineageRow {
  id: string;
  origin_kind: string;
  origin_ref: unknown;
  parent_revision_id: string | null;
  source_record_ordinal: number | string;
}

function caseRevisionLineageFingerprint(row: CaseRevisionLineageRow) {
  return sha256(
    canonicalJson({
      originKind: row.origin_kind,
      originRef: row.origin_ref,
      parentRevisionId: row.parent_revision_id,
      sourceRecordOrdinal: Number(row.source_record_ordinal),
    }),
  );
}

async function backfillCaseRevisionLineage(client: PoolClient): Promise<void> {
  const revisions = await client.query<CaseRevisionLineageRow>(
    `SELECT id, origin_kind, origin_ref, parent_revision_id,
            source_record_ordinal
     FROM case_revision WHERE lineage_fingerprint IS NULL`,
  );
  const fingerprints = revisions.rows.map((row) => ({
    id: row.id,
    fingerprint: caseRevisionLineageFingerprint(row),
  }));
  for (let offset = 0; offset < fingerprints.length; offset += 1_000) {
    const batch = fingerprints.slice(offset, offset + 1_000);
    await client.query(
      `UPDATE case_revision revision
       SET lineage_fingerprint = batch.fingerprint
       FROM unnest($1::text[], $2::text[])
         AS batch(id, fingerprint)
       WHERE revision.id = batch.id`,
      [batch.map((item) => item.id), batch.map((item) => item.fingerprint)],
    );
  }
  await client.query(
    "ALTER TABLE case_revision ALTER COLUMN lineage_fingerprint SET NOT NULL",
  );
}

interface CandidateItemLineageRow extends CaseRevisionLineageRow {
  candidate_id: string;
  ordinal: number | string;
  parent_lineage_fingerprint: string | null;
}

async function backfillCandidateItemLineage(client: PoolClient): Promise<void> {
  const items = await client.query<CandidateItemLineageRow>(
    `SELECT ci.candidate_id, ci.ordinal, ci.origin_kind, ci.origin_ref,
            ci.parent_case_revision_id AS parent_revision_id,
            ci.source_record_ordinal,
            parent.lineage_fingerprint AS parent_lineage_fingerprint
     FROM candidate_item ci
     LEFT JOIN case_revision parent ON parent.id = ci.parent_case_revision_id
     WHERE ci.lineage_fingerprint IS NULL`,
  );
  const fingerprints = items.rows.map((row) => ({
    candidateId: row.candidate_id,
    ordinal: Number(row.ordinal),
    fingerprint:
      row.origin_kind === "parent_revision" && row.parent_lineage_fingerprint
        ? row.parent_lineage_fingerprint
        : caseRevisionLineageFingerprint(row),
  }));
  for (let offset = 0; offset < fingerprints.length; offset += 1_000) {
    const batch = fingerprints.slice(offset, offset + 1_000);
    await client.query(
      `UPDATE candidate_item item
       SET lineage_fingerprint = batch.fingerprint
       FROM unnest($1::text[], $2::int[], $3::text[])
         AS batch(candidate_id, ordinal, fingerprint)
       WHERE item.candidate_id = batch.candidate_id
         AND item.ordinal = batch.ordinal`,
      [
        batch.map((item) => item.candidateId),
        batch.map((item) => item.ordinal),
        batch.map((item) => item.fingerprint),
      ],
    );
  }
}

async function backfillDraftCaseBindings(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO draft_case_binding
       (test_set_id, draft_source_id, source_id, source_record_ordinal,
        output_slot, case_id)
     SELECT wd.test_set_id, ds.draft_id, ds.id, sr.ordinal, 'primary',
            'case_' || replace(gen_random_uuid()::text, '-', '')
     FROM draft_source ds
     JOIN working_draft wd ON wd.id = ds.draft_id
     JOIN source_record sr
       ON sr.parsed_view_id = ds.parsed_view_id
      AND sr.parse_status = 'valid'
     WHERE ds.removed_at IS NULL
     ON CONFLICT DO NOTHING`,
  );
}

async function migrateJobCoordination(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE job SET idempotency_key = concat('legacy:', id)
     WHERE idempotency_key IS NULL
        OR (idempotency_key LIKE 'parse:%'
            AND idempotency_key NOT LIKE 'parse:%:%')
        OR (idempotency_key LIKE 'candidate:%'
            AND idempotency_key NOT LIKE 'candidate:%:%')`,
  );
  await client.query(
    "ALTER TABLE job ALTER COLUMN idempotency_key SET NOT NULL",
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS job_logical_operation
     ON job (project_id, kind, idempotency_key)`,
  );
}

export async function migrate(
  databaseUrl = loadConfig().databaseUrl,
): Promise<void> {
  const pool = createPool(databaseUrl);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migrationSql);
    const claimed = await client.query(
      `INSERT INTO schema_migration (id)
       VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [DRAFT_REVISION_OPERATIONS_MIGRATION],
    );
    if (claimed.rowCount) await repairLegacyDraftRevisions(client);
    const lineageClaimed = await client.query(
      `INSERT INTO schema_migration (id)
       VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [CASE_REVISION_LINEAGE_MIGRATION],
    );
    if (lineageClaimed.rowCount) await backfillCaseRevisionLineage(client);
    if (lineageClaimed.rowCount) await backfillCandidateItemLineage(client);
    const bindingsClaimed = await client.query(
      `INSERT INTO schema_migration (id)
       VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [CASE_BINDING_EAGER_MIGRATION],
    );
    if (bindingsClaimed.rowCount) await backfillDraftCaseBindings(client);
    const jobCoordinationClaimed = await client.query(
      `INSERT INTO schema_migration (id)
       VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [JOB_COORDINATION_MIGRATION],
    );
    if (jobCoordinationClaimed.rowCount) await migrateJobCoordination(client);
    await client.query(
      `INSERT INTO schema_migration (id)
       VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [TRANSFORMATION_LINEAGE_MIGRATION],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await migrate();
