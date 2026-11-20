#!/usr/bin/env bash
# Idempotency: submit, replay, 5 concurrent replays, then the same key with another body.
source "$(dirname "$0")/_lib.sh"
FROM=$(stage $SMALL_WS 0); TO=$(stage $SMALL_WS 5); KEY="demo-$(date +%s)"
BODY="{\"targetStageId\":\"$TO\",\"filter\":{\"stageId\":\"$FROM\"}}"

echo "== 1. First submit (expect 202)";            submit $SMALL_WS $KEY "$BODY"
echo "== 2. Same key, same body (expect 200, same jobId)"; submit $SMALL_WS $KEY "$BODY"
echo "== 3. 5 concurrent retries (all 200, same jobId)"
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code} ' -XPOST "$API/v1/bulk-moves" -H "X-Workspace-Id: $SMALL_WS" \
    -H "Idempotency-Key: $KEY" -H 'content-type: application/json' -d "$BODY" &
done; wait; echo
echo "== 4. Same key, different body (expect 422)"
submit $SMALL_WS $KEY "{\"targetStageId\":\"$(stage $SMALL_WS 6)\",\"filter\":{\"stageId\":\"$FROM\"}}"
echo "== Jobs created for key $KEY: $(sql "SELECT count(*) FROM idempotency_keys WHERE key='$KEY'")"
