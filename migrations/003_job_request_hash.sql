-- Store each job's canonical request hash on the job itself, so identical requests sent
-- WITHOUT an Idempotency-Key can still be recognised as duplicates (see submit.ts).
ALTER TABLE bulk_jobs ADD COLUMN request_hash text;

-- why: the keyless dedupe lookup is "same workspace + same request, newest first".
CREATE INDEX bulk_jobs_request_hash_idx ON bulk_jobs (workspace_id, request_hash, created_at DESC);
