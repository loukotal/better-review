# GitHub outbox contract

Shared types/validators: `packages/shared/src/github-outbox.ts` (root package export).
Backend seam: `packages/better-review/src/github-outbox/types.ts`.
The worker, adapter, database and browser projection implement this shared contract.
The original v1 contract has since gained desired-state draft writes, review actions,
queue deadlines, batch controls and acknowledgement-generation fences. This document
describes those implemented extensions; it does not freeze the original v1 surface.

## Admission and durability

- Browser assigns a UUID once, commits the complete command to IndexedDB, then
  calls `enqueue`. Journal failures must be visible; do not claim saved/sent.
  Replay the exact command until accepted/duplicate acknowledgement. Retain the
  acknowledged journal entry and submitted draft link across reload.
- Server commits operation and per-PR sequence before receipt. Same operation ID
  plus same original payload is duplicate; different payload is conflict, including
  after revision. Keep the original admission fingerprint separately.
- Different UUIDs with the same semantic content generally return `duplicate` with the existing
  canonical operation. Admission atomically persists the submitted UUID as an alias
  with its original fingerprint. Alias replay never expires; conflicting UUID reuse
  still rejects. Dependencies and local targets resolve aliases before validation,
  retaining PR/account/entity-kind checks. Controls may address an alias and operate
  on the canonical record with the same revision and request-idempotency rules.
- Content keys are SHA-256 over canonical PR, numeric actor ID, action and all effect
  fields (exact text, expected body/head, full anchor, target), plus dependency-set
  semantics. UUID, actor login and timestamps are excluded. Pending, inflight,
  uncertain and retry-failed matches dedup indefinitely; cancelled records never
  match. Synced matches dedup for strictly less than 60 seconds from first sync,
  not metadata enrichment. Historical synced rows without that timestamp are not
  recent-sync evidence. Keys recompute from current commands, including revisions
  and newly resolved local targets; original UUID fingerprints remain immutable.
- **Draft-stage exception:** `set-draft` never aliases historical synced operations,
  even inside the 60-second window. GitHub stage can change outside this app. Identical
  pending intents may alias, but an intervening noncancelled stage action with different
  semantics blocks reuse of the earlier intent, including across actors on that PR.
  Draft → ready → draft therefore retains all three ordered desired states.
- For approve/request-changes/review-comment, a new UUID matching recent synced content
  receives an approval/review cooldown with `retryAt`, rather than a permanent alias.
  Retain that new UUID and captured body/head/account for explicit retry after cooldown.
  Intervening noncancelled review intent from the same actor with different semantics
  prevents reuse of an earlier review; pending/uncertain duplicates still alias.
  A matching cleared, archived uncertainty rejects new admission rather than implying
  that clearing proved absence or authorized recreation.
- A resolved local target and its known remote identity compare equally; local
  reply targets use the verified root. The target's resolved creation dependency
  is implicit; other explicit dependencies remain ordering constraints. Intervening
  noncancelled actions with different semantics on the same target block dedup
  against earlier actions, preserving resolve/unresolve/resolve and edit chains.
  Edits/deletes of a candidate creation's own comment also block creation dedup,
  using its canonical local identity (including aliases) or confirmed remote ID.
  Recreating the original text after such a mutation is a distinct intent;
  mutations of unrelated comments do not block dedup.
- Browser receipts can name a different canonical UUID. Acknowledge the submitted
  journal entry atomically with its draft's canonical link; preserve the original
  command for replay. Collapse aliases in browser state/projection, never replay
  an acknowledged alias or restore its submitted draft as an unsent editor.
- Scope is lowercase owner/repo, `github.com`, positive PR number and exact canonical
  URL. Normalize before constructing commands, not silently during admission.
- Admission performs no network. Compare expected stable numeric GitHub user ID
  against cached known identity; unknown/mismatch rejects. Login is display-only.
  Never attach previously unbound work to a later login. Recheck live identity
  immediately before dispatch/reconciliation; mismatch blocks the write. Each
  adapter call verifies identity using the same credential snapshot as its HTTP
  requests; a prior worker check alone is insufficient.
- Persist commands, revisions (starting at 1), sequence, attempts, timestamps,
  dependency links, errors and results. Snapshot revision increases per PR mutation.
  Serialize worker transitions/controls in the durable transaction boundary.

## Worker/adapter rules

- PR sequencing and dependencies are durable; independent PRs can progress.
  Local refs point to creation operations, never fake GitHub numeric IDs. Validate
  dependency scope, actor, entity kind and cycles; resolve to remote IDs before
  adapter dispatch. Thread refs require the actual GraphQL thread ID, not a comment
  node ID. Adapter discovers it after inline creation if needed. Successful
  creation remains synced if thread discovery fails; read-only reconciliation
  can enrich a synced result and unblock dependent thread operations later.
- Persist `inflight` before network. Restarted inflight becomes uncertain and is
  reconciled, never blindly replayed. Transport exceptions after possible dispatch
  are uncertain. Proven pre-dispatch failure can be rejected/retryable.
- Adapter uses direct authenticated API requests and returns structured outcomes;
  catch transport failures internally. Never persist/log raw credentials, headers,
  CLI output or raw thrown causes. Unexpected adapter throws are uncertain.
- Approval, request-changes, review-comment and inline expected head SHA are immutable;
  verify fresh head and submit
  exact commit SHA. Never re-anchor to a new head. Edits/deletes compare expected
  clean body before mutation. Approvals return review ID/commit; threads return
  thread ID/state; comment mutations return real remote IDs; delete returns target.
- Dispatch result kind and target must match action. Reconciliation must exhaust
  pagination and check actor/scope/target/content/anchor/head, not merely text.
  `absent` alone never proves a timed-out mutation cannot still land. Auth failures
  are not absence. Ambiguous/conflicting evidence requires explicit user action.
- The production adapter adds a creation wire marker, stable by operation ID.
  Command bodies, expected bodies, remote result bodies and UI text are always
  clean text, never marker-bearing transport text. Do not change command identity
  when adding/removing the wire marker.

### Desired-state draft writes

`set-draft` captures the canonical PR scope, GraphQL `pullRequestId` and desired
`draft` boolean, not a toggle to recompute at dispatch. The adapter freshly verifies
the numeric viewer, exact node/URL, open PR, `viewerCanUpdate`, and author or
WRITE/MAINTAIN/ADMIN permission. An already-desired state succeeds without mutation.
Dispatch and reconciliation confirm current desired state, not causation. Candidate
verification also checks node, URL and boolean; the worker independently validates
the result. GraphQL HTTP-200 error payloads remain failed reads or uncertain mutations
according to whether a write may have occurred.

### Queue deadlines and retry cycles

- Default: **5 minutes**. The shared interface accepts safe integer millisecond
  durations from **1 through 60 minutes**. Review settings offer **5/15/30/60 minutes**;
  UI choices are narrower than the validated interface.
- Browser freezes duration and deadline when creating intent or an explicit retry.
  Editing settings, heartbeat, polling, navigation and reload do not extend saved work.
  Backend clamps a supplied deadline to the admitted duration. Original command
  fingerprints remain immutable; an explicit retry updates the operation's cycle.
- Local admission timeout retains the original UUID/body/account. A new explicit
  admission cycle carries its own idempotent request ID, duration and deadline;
  it does not rewrite the original command to evade UUID conflict checks. A replay
  of that cycle cannot restart its clock. A queued cycle can shorten, not extend,
  an already-running deadline. Unknown delivery does not become sendable via a cycle.
- Expiry blocks automatic activity. Queued/proven-not-applied work becomes
  `retry-failed`; inflight/uncertain work remains `uncertain`, with `timedOutAt` and
  blocked retry mode. An expired in-flight fence aborts the attempt without claiming
  it did not reach GitHub. Explicit read-only delivery checks remain available.
- Explicit retry of a proven-not-applied failure starts a new timed cycle, preserving
  intent identity. Automatic safe retries stay bounded within that cycle. Once a user
  overrides uncertainty, manual retry mode survives auth failures, restarts and later
  retries: the override must not silently re-enable automatic sends.

## Controls and browser lifecycle

- Controls carry UUID request ID, operation ID and expected operation revision.
  Persist deduplication before replying; replay identical request returns duplicate
  even if current revision moved. Reused request ID/different payload is conflict.
- Retry only a proven-not-applied `retry-failed` operation; reconcile uncertain
  operations using reads. Safe cancel only queued or proven-not-applied failed
  operations, never inflight/uncertain/synced. Cancelled dependencies block children.
- Batch Retry skips unknown delivery and reports that it needs confirmation. Clear
  validates revisions and cancels the affected queued/proven-not-applied suffix in
  one transaction, including followers, before the worker can resume. For inflight
  or uncertain work, Clear instead persists `uncertain` plus `archivedAt`, blocks
  automatic activity and removes it from the active queue. This is archival, not
  safe cancellation, deletion proof or permission to resend. Drafts/history retain
  the content. A durable never-send cancellation receipt also fences local UUIDs
  whose enqueue acknowledgement is late/lost; clearing is not just hiding a row.
- Revise only body-bearing, never-attempted queued operations (attempts = 0), then
  revalidate action. Identity/scope/deps/head/anchor/expectedBody stay immutable.
- Explicit uncertainty resolution requires user confirmation. Confirm-applied
  supplies only a candidate identity to `verifyApplied`; persist the adapter's
  remotely verified result, never the client-supplied payload. Commit after a
  revision check. Confirm-not-applied records an audit event and moves to
  retry-failed with `retryMode: "manual"` and no scheduled retry. The UI must warn
  that sending again may duplicate the action. A subsequent retry is a separate
  explicit decision. Never describe this as exactly-once delivery.
- Confirmed comments retain author, timestamps and (for review comments) source
  location, parent identity and any discovered thread identity for reload-safe
  rendering without an immediate successful remote refresh.
- Heartbeat is advisory visible-client state, not authorization or durability.
  Expire stale clients; backend owns retry scheduling across route changes/reload.
  `close` stops work and releases resources without deleting durable records.

## Browser confirmation authority

[`github-confirmation-state.ts`](../packages/web/src/lib/github-confirmation-state.ts)
owns observed intent IDs, receipt bridges, read-start coverage and approval/draft
selection. `github-comment-views.ts` creates one production owner across route/tab
remounts; the factory owns no transport, cache or subscriptions.

- First-seen synced history alone does not acquire new receipt authority. For an
  observed pending submission, acknowledgement may name a canonical UUID shared
  with earlier aliases. Each newly acknowledged submitted intent creates a new
  generation even when the canonical receipt had already retired. Poll/metadata
  revisions are not submission generations.
- `captureRead` snapshots actor, serial and the already-acknowledged intent set at
  **request start**. A response finishing after acknowledgement cannot retire its
  bridge if the request started before that acknowledgement or while its alias
  was pending. The owner's private snapshots do not trust mutable diagnostic maps.
- Approval selection is scoped to PR, numeric actor and captured head. Complete,
  covering detail reads, or accepted extras with verified actor/head context, can
  replace receipt authority with fresh approval/absence evidence. Serial ordering
  uses request start, including competition between detail and extras. Cached display,
  missing context, incomplete sections and mismatched identity cannot independently
  retire the bridge. Latest-review ambiguity and renewed review requests remain
  fail-closed. App presentation guards must not drop selected saved operations when
  newer detail advances the displayed head; cooldown/retry retains the original intent.
- Draft policy is separate: it selects PR-stage operations, excludes archived
  pending rows, and bridges the latest observed confirmed desired state until a
  covering fresh read matches current detail evidence with complete metadata and
  stage capabilities. Retirement remains retired across metadata revisions; a new
  acknowledged alias needs new coverage. Complete permission-denial evidence can
  retire the bridge without enabling reversal. New stage actions additionally need
  current complete actor/PR/capability evidence and an open PR; cached display is
  not write authority. Do not impose approval's head policy on draft state.

## Integration ownership

Router uses the shared admission, cycle, batch/control, heartbeat and scope validators
on unknown input, including `isGithubOutboxAdmissionInput`; no copied router validators.
Worker implements `GithubOutbox`; direct API owner implements
`GithubOutboxAdapter`; browser owner implements `GithubOutboxJournal` and projects
snapshots with local entity refs alongside existing remote comments. Keep existing
read models (`PRComment`/`IssueComment`) separate; they lack stable actor IDs and
cannot be used as identity evidence. Existing `Gh` mutation signatures are not this
adapter contract and should not constrain its stronger safety checks.

Ownership tests: backend `github-outbox/{outbox,github,runtime,lifecycle}.test.ts`;
web `lib/github-confirmation-state.test.ts` and the approval-canonical/settlement,
approval-head-cooldown, draft-intent, queue-timeout/settings, and manual-retry browser
fixtures. The HTTP composition fixture also crosses production admission/router/runtime
with real IndexedDB and SQLite; see the [completion ledger](architecture-overview-2026-10-23.md#completion-ledger).
