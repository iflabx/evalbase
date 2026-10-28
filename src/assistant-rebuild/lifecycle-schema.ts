/** Content erasure preserves execution/accounting rows and independent business assets. */
export const lifecycleSchema = `
ALTER TABLE assistant_runtime_session ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE assistant_runtime_session ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE assistant_runtime_session ADD COLUMN IF NOT EXISTS invalidation_reason text;
ALTER TABLE assistant_session ADD COLUMN IF NOT EXISTS history_deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS assistant_runtime_reference(
 session_id text NOT NULL REFERENCES assistant_runtime_session(id),
 kind text NOT NULL CHECK(kind IN('asset','draft','version','run','testSet')),
 resource_id text NOT NULL,
 PRIMARY KEY(session_id,kind,resource_id)
);
CREATE TABLE IF NOT EXISTS assistant_runtime_handoff(
 source_kind text NOT NULL CHECK(source_kind IN('formal','legacy')),
 source_id text NOT NULL, target_id text NOT NULL UNIQUE REFERENCES assistant_runtime_session(id),
 actor_id text NOT NULL REFERENCES app_user(id), project_id text NOT NULL REFERENCES project(id),
 source_revision integer NOT NULL, remaining_goal text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_kind,source_id,actor_id)
);
CREATE OR REPLACE FUNCTION purge_runtime_content(sid text, why text, removing boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $body$
DECLARE threads text[]; checkpoint_table text;
BEGIN
 PERFORM id FROM assistant_runtime_session WHERE id=sid FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT array_agg(id) INTO threads FROM assistant_runtime_turn WHERE session_id=sid;
 UPDATE assistant_runtime_session SET
  invalidated_at=coalesce(invalidated_at,now()),invalidation_reason=why,
  deleted_at=CASE WHEN removing THEN coalesce(deleted_at,now()) ELSE deleted_at END,
  revision=revision+1,requirements_revision=requirements_revision+1,
  requirements='{"objective":"","mode":"plan","deliveries":[]}',title='',status='failed',updated_at=now()
 WHERE id=sid;
 UPDATE assistant_runtime_execution SET status='failed',reason=why,lease_until=NULL,
  feedback=NULL,suspended=NULL,resume_requested=false,resume_suspended=false,seen='[]' WHERE session_id=sid;
 UPDATE assistant_runtime_turn SET payload='{}',runner_token=NULL,
  status=CASE WHEN status IN('pending','running','paused','waiting','confirmation') THEN 'failed' ELSE status END,
  error_code=CASE WHEN status IN('pending','running','paused','waiting','confirmation') THEN why ELSE error_code END
 WHERE session_id=sid;
 DELETE FROM assistant_runtime_message WHERE session_id=sid;
 UPDATE assistant_runtime_event SET detail=jsonb_build_object('code',why) WHERE session_id=sid;
 UPDATE assistant_runtime_operation SET payload='{}' WHERE session_id=sid;
 UPDATE assistant_runtime_confirmation SET payload='{}',
  status=CASE WHEN status IN('pending','executing') THEN 'expired' ELSE status END WHERE session_id=sid;
 INSERT INTO processing_cleanup(project_id,object_ref) SELECT s.project_id,a.object_ref FROM assistant_runtime_attachment a JOIN assistant_runtime_session s ON s.id=a.session_id WHERE a.session_id=sid AND a.object_ref<>'' ON CONFLICT DO NOTHING;
 UPDATE assistant_runtime_attachment SET removed_at=coalesce(removed_at,now()),extracted='{}',object_ref='' WHERE session_id=sid;
 UPDATE assistant_runtime_handoff SET remaining_goal='' WHERE target_id=sid OR (source_kind='formal' AND source_id=sid);
 UPDATE processing_run SET input_ref=NULL WHERE input_ref IS NOT NULL AND id IN(SELECT run_id FROM assistant_runtime_operation WHERE session_id=sid);
 UPDATE job SET status='cancel_requested',updated_at=now()
 WHERE status IN('queued','running','retry_wait') AND id IN
  (SELECT r.job_id FROM processing_run r JOIN assistant_runtime_operation o ON o.run_id=r.id WHERE o.session_id=sid);
 -- Saver tables appear lazily. Delete all namespaces for affected graph threads, never the ledger.
 FOREACH checkpoint_table IN ARRAY ARRAY['checkpoint_writes','checkpoint_blobs','checkpoints'] LOOP
  IF to_regclass('assistant_session_checkpoints.'||checkpoint_table) IS NOT NULL THEN
   EXECUTE format('DELETE FROM assistant_session_checkpoints.%I WHERE thread_id=ANY($1)',checkpoint_table) USING threads;
  END IF;
 END LOOP;
END $body$;
CREATE OR REPLACE FUNCTION sanitize_runtime_event() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE invalid boolean;
BEGIN
 SELECT invalidated_at IS NOT NULL INTO invalid FROM assistant_runtime_session WHERE id=NEW.session_id FOR SHARE;
 IF invalid THEN
  NEW.detail=jsonb_build_object('code','context_deleted');
 END IF;
 RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS runtime_event_content_guard ON assistant_runtime_event;
CREATE TRIGGER runtime_event_content_guard BEFORE INSERT ON assistant_runtime_event FOR EACH ROW EXECUTE FUNCTION sanitize_runtime_event();

CREATE OR REPLACE FUNCTION register_runtime_source(sid text, source jsonb) RETURNS void LANGUAGE plpgsql AS $body$
BEGIN
 IF source->>'kind'='assets' THEN
  INSERT INTO assistant_runtime_reference SELECT sid,'asset',value FROM jsonb_array_elements_text(coalesce(source->'assetIds','[]'::jsonb)) ON CONFLICT DO NOTHING;
 ELSIF source->>'kind' IN('draft','version') AND source->>'id' IS NOT NULL THEN
  INSERT INTO assistant_runtime_reference VALUES(sid,source->>'kind',source->>'id') ON CONFLICT DO NOTHING;
 END IF;
END $body$;
CREATE OR REPLACE FUNCTION record_runtime_references() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE d jsonb;
BEGIN
 IF TG_TABLE_NAME='assistant_runtime_event' THEN
  IF NEW.kind='source_read' THEN PERFORM register_runtime_source(NEW.session_id,NEW.detail->'source'); END IF;
 ELSIF TG_TABLE_NAME='assistant_runtime_session' THEN
  FOR d IN SELECT value FROM jsonb_array_elements(NEW.requirements->'deliveries') LOOP
   PERFORM register_runtime_source(NEW.id,d->'source');
  END LOOP;
 ELSIF TG_TABLE_NAME='assistant_runtime_operation' THEN
  IF NEW.run_id IS NOT NULL THEN INSERT INTO assistant_runtime_reference VALUES(NEW.session_id,'run',NEW.run_id) ON CONFLICT DO NOTHING; END IF;
 END IF;
 RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS runtime_source_references ON assistant_runtime_event;
CREATE TRIGGER runtime_source_references AFTER INSERT ON assistant_runtime_event FOR EACH ROW EXECUTE FUNCTION record_runtime_references();
DROP TRIGGER IF EXISTS runtime_requirement_references ON assistant_runtime_session;
CREATE TRIGGER runtime_requirement_references AFTER INSERT OR UPDATE OF requirements ON assistant_runtime_session FOR EACH ROW EXECUTE FUNCTION record_runtime_references();
DROP TRIGGER IF EXISTS runtime_operation_references ON assistant_runtime_operation;
CREATE TRIGGER runtime_operation_references AFTER INSERT OR UPDATE OF run_id ON assistant_runtime_operation FOR EACH ROW EXECUTE FUNCTION record_runtime_references();
-- Register existing content dependencies without changing old messages or budgets.
SELECT register_runtime_source(session_id,detail->'source') FROM assistant_runtime_event WHERE kind='source_read';
SELECT register_runtime_source(s.id,d->'source') FROM assistant_runtime_session s CROSS JOIN LATERAL jsonb_array_elements(s.requirements->'deliveries') d;
INSERT INTO assistant_runtime_reference SELECT session_id,'run',run_id FROM assistant_runtime_operation WHERE run_id IS NOT NULL ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION invalidate_runtime_resource() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE resource_kind text; target text; hit record;
BEGIN
 target=OLD.id;
 resource_kind=CASE TG_TABLE_NAME WHEN 'data_asset' THEN 'asset' WHEN 'collaborative_draft' THEN 'draft' WHEN 'test_set_version' THEN 'version' WHEN 'test_set' THEN 'testSet' WHEN 'processing_run' THEN 'run' END;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='processing_run' THEN
   IF NOT (OLD.input_ref IS NOT NULL AND NEW.input_ref IS NULL) THEN RETURN NEW; END IF;
  ELSIF NEW.status NOT IN('tombstoned','permanently_deleted','discarded','terminated') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW;
  END IF;
 END IF;
 FOR hit IN
  SELECT DISTINCT s.id FROM assistant_runtime_session s JOIN assistant_runtime_reference r ON r.session_id=s.id
  WHERE s.invalidated_at IS NULL AND (
   (r.kind=resource_kind AND r.resource_id=target) OR
   (resource_kind='testSet' AND r.kind='draft' AND r.resource_id IN(SELECT id FROM collaborative_draft WHERE test_set_id=target)) OR
   (resource_kind='testSet' AND r.kind='version' AND r.resource_id IN(SELECT id FROM test_set_version WHERE test_set_id=target)) OR
   (resource_kind='version' AND r.kind='draft' AND r.resource_id IN(SELECT id FROM collaborative_draft WHERE published_version_id=target)))
 LOOP PERFORM purge_runtime_content(hit.id,'source_deleted'); END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $body$;
DROP TRIGGER IF EXISTS runtime_asset_lifecycle ON data_asset;
CREATE TRIGGER runtime_asset_lifecycle AFTER UPDATE OF status OR DELETE ON data_asset FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_resource();
DROP TRIGGER IF EXISTS runtime_draft_lifecycle ON collaborative_draft;
CREATE TRIGGER runtime_draft_lifecycle AFTER UPDATE OF status OR DELETE ON collaborative_draft FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_resource();
DROP TRIGGER IF EXISTS runtime_version_lifecycle ON test_set_version;
CREATE TRIGGER runtime_version_lifecycle AFTER UPDATE OF status OR DELETE ON test_set_version FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_resource();
DROP TRIGGER IF EXISTS runtime_set_lifecycle ON test_set;
CREATE TRIGGER runtime_set_lifecycle AFTER UPDATE OF status OR DELETE ON test_set FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_resource();
DROP TRIGGER IF EXISTS runtime_run_lifecycle ON processing_run;
CREATE TRIGGER runtime_run_lifecycle AFTER UPDATE OF input_ref ON processing_run FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_resource();


ALTER TABLE assistant_session ADD COLUMN IF NOT EXISTS history_invalidated_at timestamptz;
CREATE OR REPLACE FUNCTION purge_legacy_history(sid text, why text, removing boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $body$
DECLARE previous_task jsonb;
BEGIN
 SELECT task INTO previous_task FROM assistant_session WHERE id=sid FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 -- Mark before document DELETE triggers run, so all entry points use this erasure exactly once.
 UPDATE assistant_session SET history_invalidated_at=coalesce(history_invalidated_at,now()) WHERE id=sid;
 UPDATE assistant_turn SET user_text='',assistant_text='',tool_results='[]',candidate_selection=NULL,dependencies='[]',requires_write=false,
 execution_token=NULL,status=CASE WHEN status IN('queued','running') THEN 'interrupted' ELSE status END,error_code='assistant_context_deleted' WHERE session_id=sid;
 UPDATE assistant_proposal SET parameters='{}',summary='{}',status=CASE WHEN status IN('pending','executing') THEN 'invalid' ELSE status END WHERE session_id=sid;
 DELETE FROM assistant_background_document WHERE session_id=sid;
 UPDATE assistant_task_checkpoint SET task=jsonb_build_object('taskId',id,'stage','failed','error','assistant_context_deleted',
 'executionBudget',task->'executionBudget','turnBudget',task->'turnBudget','budgetLedger',task->'budgetLedger'),dependencies='[]',requires_write=false WHERE session_id=sid;
 UPDATE assistant_session SET history_invalidated_at=coalesce(history_invalidated_at,now()),
 history_deleted_at=CASE WHEN removing THEN coalesce(history_deleted_at,now()) ELSE history_deleted_at END,
 title='',custom_title=NULL,content_revision=content_revision+1,task_revision=task_revision+1,
 task=jsonb_build_object('stage','failed','error','assistant_context_deleted','executionBudget',previous_task->'executionBudget','turnBudget',previous_task->'turnBudget','budgetLedger',previous_task->'budgetLedger')
 WHERE id=sid;
 UPDATE assistant_runtime_handoff SET remaining_goal='' WHERE source_kind='legacy' AND source_id='legacy:'||sid;
 UPDATE processing_run SET input_ref=NULL WHERE input_ref IS NOT NULL AND task_id IN(SELECT id FROM processing_task WHERE assistant_session_id=sid);
 UPDATE job SET status='cancel_requested',updated_at=now() WHERE status IN('queued','running','retry_wait') AND id IN(
 SELECT r.job_id FROM processing_run r JOIN processing_task t ON t.id=r.task_id WHERE t.assistant_session_id=sid);
END $body$;
-- Replace the old document-specific scrubber: it discarded successful receipts and pre-v1 checkpoint budgets.
CREATE OR REPLACE FUNCTION purge_assistant_background_document() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 UPDATE processing_run SET input_ref=NULL WHERE input_ref IS NOT NULL AND background_document_ids @> ARRAY[OLD.id];
 IF EXISTS(SELECT 1 FROM assistant_session WHERE id=OLD.session_id AND history_invalidated_at IS NULL) THEN
  PERFORM purge_legacy_history(OLD.session_id,'background_deleted');
 END IF;
 RETURN OLD;
END $body$;
CREATE OR REPLACE FUNCTION invalidate_runtime_global_role() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE hit record;
BEGIN
 IF OLD.role='admin' AND NEW.role<>'admin' THEN
 FOR hit IN SELECT id FROM assistant_runtime_session WHERE actor_id=OLD.id AND invalidated_at IS NULL LOOP PERFORM purge_runtime_content(hit.id,'access_revoked'); END LOOP;
 FOR hit IN SELECT id FROM assistant_session WHERE actor_id=OLD.id AND history_invalidated_at IS NULL LOOP PERFORM purge_legacy_history(hit.id,'access_revoked'); END LOOP;
 END IF;
 RETURN NEW;
END $body$;
DROP TRIGGER IF EXISTS runtime_role_lifecycle ON app_user;
CREATE TRIGGER runtime_role_lifecycle AFTER UPDATE OF role ON app_user FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_global_role();

CREATE OR REPLACE FUNCTION invalidate_runtime_membership() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE hit record;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (CASE NEW.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END)>=(CASE OLD.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END) THEN RETURN NEW; END IF;
 END IF;
 FOR hit IN SELECT id FROM assistant_runtime_session WHERE actor_id=OLD.user_id AND project_id=OLD.project_id AND invalidated_at IS NULL
 LOOP PERFORM purge_runtime_content(hit.id,'access_revoked'); END LOOP;
 FOR hit IN SELECT id FROM assistant_session WHERE actor_id=OLD.user_id AND project_id=OLD.project_id AND history_invalidated_at IS NULL LOOP PERFORM purge_legacy_history(hit.id,'access_revoked'); END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $body$;
DROP TRIGGER IF EXISTS runtime_membership_lifecycle ON project_member;
CREATE TRIGGER runtime_membership_lifecycle AFTER UPDATE OF role OR DELETE ON project_member FOR EACH ROW EXECUTE FUNCTION invalidate_runtime_membership();
`;
