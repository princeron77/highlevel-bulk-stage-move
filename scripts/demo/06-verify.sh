#!/usr/bin/env bash
# Proof a job is correct, straight from the tables:  06-verify.sh <jobId>
source "$(dirname "$0")/_lib.sh"
JOB=$1
docker compose exec -T postgres psql -U app -d opportunities -c "
SELECT j.status, j.total, j.moved, j.skipped_conflict, j.skipped_noop,
  (SELECT count(*) FROM bulk_job_items WHERE job_id = j.id AND outcome IS NULL) AS items_without_outcome,
  (SELECT count(*) FROM stage_transitions WHERE bulk_job_id = j.id) AS bulk_transitions,
  (SELECT count(*) FROM (SELECT 1 FROM stage_transitions WHERE bulk_job_id = j.id
     GROUP BY opportunity_id HAVING count(*) > 1) d) AS moved_twice
FROM bulk_jobs j WHERE j.id = '$JOB';"
