# API

Base URL `http://localhost:3000`. Interactive docs (OpenAPI/Swagger): **`/docs`**.

Every request needs `X-Workspace-Id: <uuid>`. It scopes all data; another workspace's data
returns `404`. Errors always look like this:

```json
{ "statusCode": 422, "error": "Unprocessable Entity", "message": "…", "requestId": "…" }
```

The examples use the seeded workspace:
```bash
WS=b0000000-0000-4000-8000-000000000001
H="-H X-Workspace-Id:$WS -H content-type:application/json"
```

## Stages
```bash
curl -s localhost:3000/v1/stages $H
# [{"id":"…","name":"New Lead","position":0}, …]
```

## Create an opportunity
```bash
curl -s -XPOST localhost:3000/v1/opportunities $H \
  -d '{"name":"Acme renewal","valueCents":2500000,"status":"open","ownerId":"owner-7","stageId":"<stage>"}'
# 201 {"id":"…","stageId":"…","stageRev":0, …}
```

## Move one opportunity (manual)
```bash
curl -s -XPATCH localhost:3000/v1/opportunities/<id>/stage $H -d '{"stageId":"<stage>"}'
# 200 {… "stageRev": 1}
```
Records a `manual` transition. If the row is locked by a bulk chunk it waits up to 1 s, retries
once, then returns `503` (safe to retry).

## List a stage
```bash
curl -s "localhost:3000/v1/stages/<stage>/opportunities?limit=50" $H
# {"data":[…], "nextCursor":"eyJj…"}   -> pass ?cursor=<nextCursor> for the next page
```

## Submit a bulk move
```bash
curl -s -i -XPOST localhost:3000/v1/bulk-moves $H -H 'Idempotency-Key: move-2026-11-21-1' \
  -d '{"targetStageId":"<stage B>","filter":{"stageId":"<stage A>","status":"open"}}'
# HTTP 202  Location: /v1/bulk-moves/<jobId>
# {"jobId":"…","replayed":false,"progressUrl":"/v1/bulk-moves/<jobId>"}
```

The filter fields are all optional and combined with AND: `stageId`, `ownerId`, `status`,
`minValueCents`, `maxValueCents`, `createdFrom` (inclusive) and `createdTo` (exclusive).

| Situation | Response |
|---|---|
| New key | `202` and a new job |
| Same key, same body (a retry, also when concurrent) | `200`, same `jobId`, `"replayed": true` |
| Same key, different body | `422` |
| More than 50,000 matches | `422`; nothing is written |
| Missing `Idempotency-Key` | `400` |
| Target stage not in this workspace | `404` |

## Progress
```bash
curl -s localhost:3000/v1/bulk-moves/<jobId> $H
```
```json
{
  "jobId": "…", "status": "processing", "health": "running",
  "total": 871, "processed": 500, "percent": 57.4,
  "counts": { "moved": 497, "skippedConflict": 2, "skippedNoop": 1, "pending": 371 },
  "attempts": 0, "lastError": null, "failureReason": null, "nextAttemptAt": null,
  "createdAt": "…", "startedAt": "…", "lastProgressAt": "…", "heartbeatAt": "…", "finishedAt": null
}
```

| `health` | Meaning |
|---|---|
| `queued` | Waiting for its first turn. Another job in this workspace may be running. |
| `running` | A worker holds a live lease and is moving rows. |
| `throttled` | Paused by the workspace's rate limit. Slow on purpose. |
| `waiting` | Between time slices, waiting for its next turn. Normal under load. |
| `retrying` | A transient error happened; it retries at `nextAttemptAt`. |
| `stalled` | No live worker and no progress for 2× the lease time. Stuck. |
| `done` / `failed` | Finished. `failureReason` says why it failed. |

## Per-deal outcomes
```bash
curl -s "localhost:3000/v1/bulk-moves/<jobId>/items?outcome=skipped_conflict&limit=100" $H
# {"data":[{"seq":12,"opportunityId":"…","snapshotStageId":"…","outcome":"skipped_conflict"}], "nextAfterSeq":null}
```
`outcome` is one of `moved`, `skipped_conflict`, `skipped_noop` or `pending`. Page with
`?afterSeq=<nextAfterSeq>`.

## Resume a failed job
```bash
curl -s -XPOST localhost:3000/v1/bulk-moves/<jobId>/retry $H
```
| Job state | Response |
|---|---|
| `failed` | `202`: re-queued. It continues from `processed`; nothing already applied is redone. |
| `queued` / `processing` | `200`: nothing changed. Safe to call twice. |
| `completed` | `422` |
