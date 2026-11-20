#!/usr/bin/env bash
# Concurrent edit: start a big job, move one of its not-yet-processed deals by hand, show the job skips it.
source "$(dirname "$0")/_lib.sh"
BODY=$(fifty_k_body)
submit $LARGE_WS "conflict-$(date +%s)" "$BODY"
JOB=$(cat /tmp/demo-submit.json | json '.jobId')
OPP=$(sql "SELECT opportunity_id FROM bulk_job_items WHERE job_id='$JOB' ORDER BY seq DESC LIMIT 1")
# a stage that is neither the job's source nor its target
MANUAL=$(sql "SELECT id FROM stages WHERE workspace_id='$LARGE_WS' AND id::text NOT IN ('$(echo "$BODY" | json '.targetStageId')','$(echo "$BODY" | json '.filter.stageId')') ORDER BY position LIMIT 1")
echo "== A human moves deal $OPP (last in the job) to another stage while the job runs:"
curl -s -XPATCH "$API/v1/opportunities/$OPP/stage" -H "X-Workspace-Id: $LARGE_WS" \
  -H 'content-type: application/json' -d "{\"stageId\":\"$MANUAL\"}" | json '.stageRev' | sed 's/^/   stageRev now /'
"$(dirname "$0")/02-watch.sh" $JOB $LARGE_WS
echo "== Outcome for that deal:"
curl -s "$API/v1/bulk-moves/$JOB/items?outcome=skipped_conflict" -H "X-Workspace-Id: $LARGE_WS" | json '.data'
echo "== Its stage is still the manual one: $( [[ $(sql "SELECT stage_id FROM opportunities WHERE id='$OPP'") == $MANUAL ]] && echo yes )"
