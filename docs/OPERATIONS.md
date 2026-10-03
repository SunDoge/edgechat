# Operations and recovery runbook

EdgeChat's routine operational plane is D1-ledger driven. It must not list or
read the R2/S3 bucket to render a dashboard. Provider inspection is reserved for
an explicit offline integrity audit because bucket scans consume billable
operations and do not scale as a health check.

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
- credential-verified account appeals must be handled or expire within seven days.

The endpoint becomes `degraded` and emits stable reason codes when the oldest
item breaches one of these objectives. A non-empty but young queue is healthy.
Alert on a degraded result for two consecutive checks, not on queue count alone.
The public `/api/v1/health` remains a shallow liveness/protocol endpoint and must
not expose operational inventory.

Every API response carries a server-generated `x-edgechat-request-id`. Error
responses repeat the same opaque value as `request_id`; unexpected-failure and
schema-mismatch logs record it with the HTTP method and path. Ask a user for the
displayed failure number when investigating a generic server error, then filter
Workers Logs by `request_id`. The value is correlation metadata only: it must
never contain or be replaced by a user ID, room ID, bearer token, object key, IP
address, or arbitrary client-supplied header. Generating and transporting it
does not read or write D1/R2/S3.

Expired one-time device-session challenges are removed by the normal scheduled
Worker cleanup. Each device has at most one outstanding row, challenges expire
after five minutes, and issuing or claiming one never reads or writes object
storage. Password logout of other devices removes their outstanding challenges
and invalidates their hashed device credentials immediately.

Passkey registration/authentication challenges use the same five-minute
scheduled-cleanup model in D1. Each account has at most one pending challenge
per purpose. Passkey public keys and counters are D1 metadata; routine passkey
login, enrollment, listing, removal, and cleanup must not access R2/S3.

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

1. Install the pinned non-Chromium browser runtimes once with
   `pnpm browser:install:matrix`, then run `pnpm check:release` from the exact
   revision. This composes migration/type generation verification, TypeScript
   and Rust/OpenMLS tests, production builds, the high-severity production
   dependency audit, an isolated local-Worker two-device messaging smoke, and
   the Chromium/Firefox/WebKit database, tab handoff, rendered update/recovery,
   and offline PWA gates. The browser gates reuse the exact production build
   created by `pnpm check`; they do not rebuild a different artifact. Apart from
   the package-registry audit, every gate is loopback-only. The messaging smoke
   uses temporary local D1/R2/Durable Object state and deletes it afterward;
   no phase contacts Cloudflare or an external S3 provider.
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
5. Run `pnpm run audit:storage` once with the staging provider and an explicit
   `--max-list-requests` budget. This is the exceptional operation allowed to
   list the bucket; record the reported request count and findings.
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

R2 currently provides the durable ciphertext object plane through the Worker's
provider-neutral `ObjectStore` interface. Production code uses only exact-key
put/get/head/delete operations; the interface intentionally has no list method.
The R2 adapter normalizes Range, metadata, SHA-256 mismatch and create-if-absent
semantics. The SigV4 S3/B2 adapter must pass the same contract against the
selected live provider before that provider is deployable. D1—not ETag or provider metadata—is
authoritative for keys, sizes, digests, accounting, retention and repair state.
Object metadata keys are restricted to lowercase snake_case before any provider
request. This prevents case-insensitive S3/B2 headers from changing a key such
as `roomId` during HEAD and breaking exact crash recovery while native R2 still
appears to work.

Normal attachment upload uses one client-chosen 192-bit opaque ID and one
conditional PUT. D1 binds that ID to the uploader, room, size and ciphertext
digest. Retrying after an ambiguous response returns the committed D1 row with
zero object-store requests. Only the crash window after PUT but before D1
finalization retains an exact write intent. A byte-identical retry first uses
one exact-key HEAD: matching size and bound metadata commits the existing object
without reading it or retransmitting ciphertext; a missing object falls through
to one conditional PUT. A conflicting object is rejected. This recovery never
creates a second key or uses GET/LIST, and a normal first attempt still uses one
PUT without a discovery HEAD. The client records the ID before its first
request, so a terminal or downstream
failure can cancel the exact claim. Cancellation marks the D1 intent first and
uses one exact-key DELETE; a concurrently finishing PUT rechecks that marker and
deletes the same key itself. It performs no discovery HEAD/LIST and returns the
quota reservation exactly once.

Linked-device history uses only a D1 manifest plus temporary, independently
authenticated 16 MiB plaintext shards; there is no whole-bundle object route.
Each shard follows the same conditional checksum PUT and exact-key cleanup
contract. The target acknowledges a shard only after durable local staging,
which deletes that exact object and returns quota immediately. If a manifest
exists, the Worker refuses session claim until every distinct shard is durably
staged and acknowledged by the target, and refuses new manifests or uploads
after claim. A successful claim therefore leaves no temporary history object or
quota charge. Normal request
cost is therefore one PUT, one GET and one DELETE per shard, with no LIST and no
unbounded single history object. The source retains the manifest-bound local
snapshot until the target's durable claim event. A first GET that finds a
missing object or invalid metadata records a D1 repair circuit and emits a
content-free device event; later target retries do not issue another object GET.
The source re-encrypts the same shard index from the retained snapshot. Missing
objects release their D1 row and quota immediately. Invalid objects retain their
exact D1 identity until the source deletes that exact key before the replacement
PUT. Repair uses no LIST and never substitutes a newly generated snapshot under
an existing manifest.

For a multi-part message the PWA writes one bounded PGlite cleanup journal with
all opaque attachment IDs before the first PUT. Crossing the crash-safe outgoing
MLS staging/outbox boundary removes that journal. After a page crash, startup or
durable reconnect first checks local outgoing staging, outbox, and projected
message evidence: any match proves the send is durable and suppresses cleanup;
otherwise one at-most-ten-ID abandonment request exact-deletes only uncommitted
objects/claims and then removes their local cache files. An offline cleanup keeps
the journal and ciphertext for retry. This recovery performs no LIST, HEAD, GET,
or additional PUT and does not wait for the seven-day server backstop.

Profile avatars use a separate exact-key D1 ledger because one short-lived row
must cover both the PUT-to-profile-CAS crash window and later replacement
deletion. Scheduled cleanup ignores fresh write intents, atomically leases an
eligible deletion before calling the provider, and can recover an expired
cleaner lease. It drops a ledger row without deleting whenever D1 identifies
that key as the current avatar. While any different avatar key for that account
is unresolved, a new upload is rejected before object storage; retrying the
same content-addressed bytes refreshes the original intent. Thus the healthy
replacement path remains one PUT and one exact DELETE, and a provider deletion
outage cannot turn repeated avatar changes into unbounded objects. No avatar
path uses LIST, discovery HEAD, or GET for cleanup.

The public avatar read also validates D1's expected size and SHA-256 metadata.
The first missing or inconsistent object creates a D1 repair job; while that job
exists, later reads fail from D1 without another object-store GET. The owner can
select the same local image to acquire a bounded repair lease and overwrite the
same content-addressed key with a provider-verified checksum. Completion removes
the circuit without changing storage quota or object count. A lost repair
response is served from the now-cleared D1 job on retry; a crash before commit
leaves the job for lease-expiry retry. This path uses one repair PUT and no LIST
or HEAD.

Attachments, archive segments, and avatars share the same corrupt-object cleanup
barrier. A metadata or digest failure first records `cleanup_pending` against the
repair generation observed by that GET, then issues one exact-key DELETE. Repair
leases and uploads remain unavailable until the DELETE succeeds. A failed or
crash-interrupted deletion stays visible in the D1 repair queue; scheduled work
claims at most 100 entries that have cooled for five minutes, retries only their
recorded exact keys, and clears the barrier after success. Candidates from all
three object classes are globally ordered by their oldest D1 update, so a full or
failing attachment queue cannot starve archive or avatar cleanup. One failed
exact DELETE is recorded and isolated without aborting later entries in the same
batch. Successful replacement
atomically advances the source row's repair generation and removes its job, so a
stale concurrent GET cannot recreate the old job or delete the replacement.
Healthy object reads incur no extra request, and cleanup adds no LIST, discovery
HEAD, or speculative GET.

Archive compaction likewise retries at most once with the lease's preallocated
segment ID and byte-identical ciphertext. The Worker binds an already committed
ID to its room, sequence range, size and digest; a lost-response retry is served
from D1 before object-store access, while conflicting reuse is rejected. In the
post-PUT/pre-D1 crash window, the exact pending intent permits one HEAD of that
key: matching room/segment/range/size/digest metadata commits without a second
PUT or request-body transfer, while a missing object falls through to the normal
conditional PUT. A first attempt remains one PUT with no HEAD, and recovery uses
neither GET nor LIST. This preserves the device's OPFS repair copy without
retransmitting a 1–10 MiB segment after an ambiguous response. If both responses
fail, the client resolves the
same ID/range/size/digest: an existing D1 row is treated as committed, while an
in-flight claim is marked cancelled before one exact DELETE. The uploader checks
that marker and revalidates its lease after PUT, immediately before the D1
commit, and removes a late object itself.

Linked-device history uses temporary 16 MiB ciphertext shards. Each shard upload
pins its SHA-256 in D1 and provider metadata and uses a conditional,
provider-checksummed PUT. A lost response is retried once with the same in-memory
bytes: a committed shard returns from D1 with no object request; an exact pending
intent performs one HEAD and cancels the retry body when size, digest, link,
transfer, target and shard index match. A missing object falls through to PUT.
This recovery performs no GET/LIST and cannot overwrite a conflicting shard.

Room peer recovery uses one temporary object per at-most-500-event encrypted
batch. The first target GET that finds a missing object or invalid provider
metadata atomically returns its quota and moves the D1 recovery row back to
`pending`. Invalid bytes are deleted by their exact recorded key; an absent
object is not deleted again. A fresh content-free device event wakes eligible
source endpoints, and a new lease produces one replacement conditional PUT
under a new opaque key. Until then target status polling is D1-only, so the bad
key receives at most one failed GET per repair episode. This path uses no LIST
or discovery HEAD.

If the page crashes after recording `uploading`, or the immediate resolution
request is also offline and records `upload_unknown`, startup and later durable
sync activity retry that bounded queue from the exact OPFS ciphertext. A new
compaction for that room is refused while either state—or a post-commit
`uploaded` retention acknowledgement—remains unresolved, so the room-keyed job
cannot be overwritten. Recovery uses the committed row or the exact D1 write
intent even after the original lease has expired. This resolution endpoint (as
distinct from retrying the upload itself) performs no LIST, HEAD, GET, or
speculative DELETE. A missing D1 intent is `absent`, and the
late-uploader lease check owns any eventual exact cleanup. Only an exact
committed result is acknowledged as retained; only an exact abandoned/absent
result permits the local repair copy to be removed. Committed metadata is never
deleted.

EdgeChat does not make a second R2/S3 copy by default, does not store plaintext backups, and does not
enable lifecycle deletion on committed `attachments/` or `rooms/` prefixes.
Routine readiness uses the D1 ledger; periodic integrity audits may list the
bucket; client repair covers exact missing ciphertext when an acknowledged device
still has it. Operators who require an independent provider backup may add one as
an explicit costed policy, but it is outside the default architecture and must
preserve ciphertext, opaque keys and deletion/retention semantics. A deployment
must select one primary provider; default dual writes are prohibited because they
double object operations and create ambiguous partial-failure semantics.

### Selecting an S3-compatible provider

The checked-in Wrangler configuration selects `r2`. To use Backblaze B2 or
another path-style SigV4 provider, set these non-secret Worker variables in the
target environment:

```jsonc
{
  "OBJECT_STORE_PROVIDER": "s3",
  "S3_ENDPOINT": "https://s3.<region>.backblazeb2.com",
  "S3_REGION": "<region>",
  "S3_BUCKET": "<private-bucket>"
}
```

Store `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` as Worker secrets; set the
optional `S3_SESSION_TOKEN` secret only for temporary credentials. Never commit
them or expose them to the PWA. For example, run the interactive commands:

```sh
pnpm --filter @edgechat/worker exec wrangler secret put S3_ACCESS_KEY_ID
pnpm --filter @edgechat/worker exec wrangler secret put S3_SECRET_ACCESS_KEY
```

An S3-only environment may remove the unused `ARCHIVE` R2 binding. Regenerate
Worker types after changing the target Wrangler configuration. The adapter signs
each request with SigV4, sends one PUT per object, rejects a provider that ignores
a byte Range, and groups exact-key deletion into batches of at most 1,000 keys.
It does not perform hidden automatic retries or bucket listing; durable D1 jobs
own retries and repair.

Before production selection, run the object-store contract against the actual
provider and verify conditional PUT, signed streaming SHA-256, custom metadata,
HEAD, exact `206 Content-Range`, and multi-object deletion. B2 buckets retain
versions: a name-only delete can leave a hidden prior version, so configure a
reviewed lifecycle rule for hidden/old versions. Until that lifecycle is proven,
application quota reclamation may precede physical B2 byte reclamation and B2
must not be presented as immediate physical erasure.

Use a disposable private staging bucket and credentials scoped to that bucket.
The live probe imports the same `S3ObjectStore` class used by the Worker and is
excluded from every normal `pnpm test`/`pnpm check` run. The confirmation value
is bound to the exact bucket name:

```sh
export S3_ENDPOINT='https://s3.<region>.backblazeb2.com'
export S3_REGION='<region>'
export S3_BUCKET='<disposable-staging-bucket>'
export S3_ACCESS_KEY_ID='<staging-key-id>'
export S3_SECRET_ACCESS_KEY='<staging-application-key>'
export EDGECHAT_LIVE_S3_CONFIRM="write-and-delete:${S3_BUCKET}"
pnpm test:object-store:live
```

The successful path makes exactly seven provider requests: three PUTs (one must
return the conditional conflict and one must reject a bad digest), one HEAD, one
strict Range GET, one batch DELETE, and one deletion-verification HEAD. It never
lists the bucket or downloads the complete test object. Failure cleanup may add
one exact-key batch DELETE. Record the UTC time, revision, provider/region,
staging bucket, test output, lifecycle rule and resulting empty
`edgechat-contract/` prefix; never record credentials. A passing probe does not
verify lifecycle removal of hidden B2 versions.

The offline D1-ledger audit also supports this provider. Use a separate list-only
application key and an explicit request cap:

```sh
S3_ENDPOINT='https://s3.<region>.backblazeb2.com' \
S3_REGION='<region>' \
S3_ACCESS_KEY_ID='<list-only-key-id>' \
S3_SECRET_ACCESS_KEY='<list-only-application-key>' \
CLOUDFLARE_API_TOKEN='<D1-read-only-token>' \
pnpm run audit:storage -- --provider s3 --account-id '<account>' \
  --database-id '<database>' --bucket '<bucket>' --max-list-requests 1000
```

The audit performs only D1 queries and ListObjectsV2, records the exact LIST
count, and aborts before crossing its request budget. It does not GET bodies,
HEAD objects, mutate D1, or delete keys. ListObjectsV2 reports current names; it
cannot prove that B2 hidden versions have been reclaimed, so review the bucket's
version/lifecycle state separately.
