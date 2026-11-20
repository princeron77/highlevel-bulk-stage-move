#!/usr/bin/env bash
# Isolation: a 50k job in the large workspace does not block a small job in another workspace.
source "$(dirname "$0")/_lib.sh"
submit $LARGE_WS "big-$(date +%s)" "$(fifty_k_body)"; BIG=$(cat /tmp/demo-submit.json | json '.jobId')
sleep 2
# the small workspace's fullest stage -> its emptiest stage, so re-runs always have work to do
S_FROM=$(sql "SELECT s.id FROM stages s JOIN opportunities o ON o.stage_id=s.id WHERE s.workspace_id='$SMALL_WS' GROUP BY s.id ORDER BY count(*) DESC LIMIT 1")
S_TO=$(sql "SELECT s.id FROM stages s LEFT JOIN opportunities o ON o.stage_id=s.id WHERE s.workspace_id='$SMALL_WS' GROUP BY s.id ORDER BY count(o.id) ASC LIMIT 1")
submit $SMALL_WS "small-$(date +%s)" "{\"targetStageId\":\"$S_TO\",\"filter\":{\"stageId\":\"$S_FROM\"}}"
SMALL=$(cat /tmp/demo-submit.json | json '.jobId')
for i in $(seq 1 8); do
  echo "big:   $(progress $LARGE_WS $BIG)"; echo "small: $(progress $SMALL_WS $SMALL)"; echo; sleep 0.7
done
