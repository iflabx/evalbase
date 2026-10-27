export const workspaceSchema = `
ALTER TABLE assistant_runtime_session ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE assistant_runtime_activity ADD COLUMN IF NOT EXISTS row_limit integer;
ALTER TABLE assistant_runtime_activity ADD COLUMN IF NOT EXISTS rows_used integer NOT NULL DEFAULT 0;
ALTER TABLE assistant_runtime_operation ADD COLUMN IF NOT EXISTS rows_admitted boolean NOT NULL DEFAULT false;
ALTER TABLE assistant_runtime_execution ADD COLUMN IF NOT EXISTS suspended jsonb;
ALTER TABLE assistant_runtime_execution ADD COLUMN IF NOT EXISTS resume_suspended boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS assistant_runtime_attachment(
 id text PRIMARY KEY, session_id text NOT NULL REFERENCES assistant_runtime_session(id),
 name text NOT NULL, object_ref text NOT NULL, extracted jsonb NOT NULL,
 removed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_runtime_attachment_session ON assistant_runtime_attachment(session_id);
`;
