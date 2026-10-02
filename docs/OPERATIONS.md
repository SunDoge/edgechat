# Operations and recovery runbook

EdgeChat's routine operational plane is D1-ledger driven. It must not list or
read the R2 bucket to render a dashboard. R2 inspection is reserved for an
explicit offline integrity audit because bucket scans create Class A operations
and do not scale as a health check.

## Readiness snapshot and SLOs

Run:

```bash
EDGECHAT_URL=https://chat.example.com \
EDGECHAT_OPERATOR_TOKEN="$OPERATOR_TOKEN" \
pnpm run operator -- readiness
```

`GET /api/v1/operator/readiness` performs one D1 statement. It reports active
user/device/room inventory, the indexed sync-cursor high-water mark,
quota-ledger bytes/objects, and the
count plus oldest age for each durable work queue. `storage_source` must remain
`d1_ledger`; adding an R2 `list()`, `head()` or `get()` to this endpoint is a
regression.

The initial service objectives are deliberately easy to explain:

- pending R2 write intents must be finalized or rolled back within 30 minutes;
- object deletion, repair, account deletion, device revocation and peer recovery
  work must make progress within 24 hours;
- password-verified account appeals must be handled or expire within seven days.

The endpoint becomes `degraded` and emits stable reason codes when the oldest
item breaches one of these objectives. A non-empty but young queue is healthy.
Alert on a degraded result for two consecutive checks, not on queue count alone.
The public `/api/v1/health` remains a shallow liveness/protocol endpoint and must
not expose operational inventory.

## Structured security events

Workers Observability is enabled in `wrangler.jsonc`. Security events are logged
as JSON objects with stable `security.*` names so they can be filtered without
parsing text. The typed logger intentionally permits only low-cardinality fields:

- `security.rate_limited` with a non-secret reason code;
- `security.login_locked`;
- `security.operator_auth_failed`;
- `security.account_appeal_submitted` with category and replacement flag;
- `security.account_appeal_resolved` with resolution and login-unlock flag.

Never add user IDs, room IDs, IP addresses, passwords, bearer capabilities,
ciphertext, message text, filenames or arbitrary error strings to these events.
Cloudflare recommends structured JSON for searchable Workers Logs. Sampling and
retention are Cloudflare account policy; exporting logs to R2/S3 is not required
by EdgeChat and should not be enabled merely to build this dashboard.

## Before a schema or protocol rollout

1. Confirm the Worker build and full test suite pass from the exact revision.
2. Run `pnpm run db:migrations:check`. Every recorded migration must retain its
   exact SHA-256 digest and filenames must form one contiguous zero-padded
   sequence. Never edit a recorded migration; add the next file instead.
3. Record the current remote D1 Time Travel bookmark:

   ```bash
   pnpm run db:bookmark:remote
   ```

4. Save the bookmark, revision, migration list and UTC time in the deployment
   record. Do not store Cloudflare credentials in that record.
5. Apply migrations with `pnpm --filter @edgechat/worker db:migrate:remote`, then
   deploy the Worker.
6. Check `pnpm run operator -- readiness`, `/api/v1/health`, login, sync, one MLS
   message, attachment download and a Range history read.
7. Keep the preceding Worker artifact available until the mixed-version window
   has passed. A code rollback is safe only when that code accepts the resulting
   schema and advertised protocol range.

New migrations are recorded explicitly with `pnpm run db:migrations:record`.
They must declare one rollout phase:

```sql
-- edgechat-migration-phase: expand
```

`expand` may only add compatible schema. A `data` migration that rewrites rows
also needs `-- edgechat-migration-approval: <review reference>`. A `contract`
migration additionally needs `-- edgechat-min-worker-protocol: <version>` and is
valid only after older Workers/clients are outside the supported version window.
The recorder refuses missing numbers, edits to recorded SQL, unreviewed data
rewrites, destructive statements mislabeled as expansion, and disabling foreign
keys. Updating `manifest.json` by hand defeats the release gate and is forbidden.

PGlite has a separate client-local migration ledger in
`packages/db/src/migrations.ts`. `packages/db/src/schema.ts` is the immutable
version-1 payload: after release, do not edit it or any recorded migration.
Append one contiguous migration, compute and commit its SHA-256 digest, and add
tests for both upgrade and interrupted/failing execution. Every local database
open verifies the complete applied history and runs each pending migration in a
transaction. Backup restore applies this same gate to the staging database
before activation. An older client intentionally refuses a database written by
a newer client; do not advise users to clear local storage as a rollback. Deploy
an accepting client or restore an explicitly user-created encrypted backup.
These migrations are entirely browser-local and make no D1 or R2/S3 request.

Cloudflare D1 Time Travel is automatic. On the production storage backend it can
restore by timestamp or bookmark; the documented history window is up to 30 days
on Workers Paid and seven days on Workers Free. A restore overwrites the database
in place and cancels in-flight work, so it is an incident action—not a routine
migration command. Official reference:
<https://developers.cloudflare.com/d1/reference/time-travel/>.

## Quarterly recovery exercise

Use a staging database and staging bucket populated only with synthetic users.
Never practice an in-place restore against production.

1. Record a D1 bookmark and the readiness response.
2. Create synthetic users, an MLS room, events, an attachment and one archive
   segment; retain one authorized device cache.
3. Simulate a D1 metadata mistake, restore staging to the recorded bookmark and
   save the `previous_bookmark` returned by Cloudflare so the restore itself can
   be undone.
4. Redeploy the matching Worker revision and verify the readiness query before
   allowing clients to write.
5. Run `pnpm run audit:storage` once. This is the exceptional operation allowed
   to list R2; record request count and findings.
6. Verify a client can sync ciphertext, decrypt locally, search plaintext locally,
   and repair an intentionally missing attachment or segment from an acknowledged
   device cache without changing quota.
7. Verify data below an intentional retention floor is not resurrected.
8. Record recovery-point and recovery-time observations, then delete the staging
   fixtures by exact key.

Restoring D1 can reintroduce metadata referring to an R2 object that was deleted
after the chosen bookmark. EdgeChat therefore treats D1 restore and object repair
as separate steps. Device repair may recreate only the exact authenticated bytes
for a still-authorized object; it must never recreate intentionally collected
history below the authoritative retention floor.

## R2/S3 posture

R2 already provides the durable ciphertext object plane. EdgeChat does not make
a second R2/S3 copy by default, does not store plaintext backups, and does not
enable lifecycle deletion on committed `attachments/` or `rooms/` prefixes.
Routine readiness uses the D1 ledger; periodic integrity audits may list the
bucket; client repair covers exact missing ciphertext when an acknowledged device
still has it. Operators who require an independent provider backup may add one as
an explicit costed policy, but it is outside the default architecture and must
preserve ciphertext, opaque keys and deletion/retention semantics.
