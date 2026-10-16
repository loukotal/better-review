# GitHub outbox contract (frozen v1)

Shared types/validators: `packages/shared/src/github-outbox.ts` (root package export).
Backend seam: `packages/better-review/src/github-outbox/types.ts`.
The worker, adapter, database and browser projection implement this shared contract.

## Admission and durability

- Browser assigns a UUID once, commits the complete command to IndexedDB, then
  calls `enqueue`. Journal failures must be visible; do not claim saved/sent.
  Replay the exact command after reload; remove only on accepted/duplicate receipt.
- Server commits operation and per-PR sequence before receipt. Same operation ID
  plus same original payload is duplicate; different payload is conflict, including
  after revision. Keep the original admission fingerprint separately.
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
- Approval and inline expected head SHA are immutable; verify fresh head and submit
  exact commit SHA. Never re-anchor to a new head. Edits/deletes compare expected
  clean body before mutation. Approvals return review ID/commit; threads return
  thread ID/state; comment mutations return real remote IDs; delete returns target.
- Dispatch result kind and target must match action. Reconciliation must exhaust
  pagination and check actor/scope/target/content/anchor/head, not merely text.
  `absent` alone never proves a timed-out mutation cannot still land. Auth failures
  are not absence. Ambiguous/conflicting evidence requires explicit user action.
- Optional creation wire marker is adapter-owned and stable by operation ID.
  Command bodies, expected bodies, remote result bodies and UI text are always
  clean text, never marker-bearing transport text. Do not change command identity
  when adding/removing the wire marker.

## Controls and browser lifecycle

- Controls carry UUID request ID, operation ID and expected operation revision.
  Persist deduplication before replying; replay identical request returns duplicate
  even if current revision moved. Reused request ID/different payload is conflict.
- Retry only a proven-not-applied `retry-failed` operation; reconcile uncertain
  operations using reads. Safe cancel only queued or proven-not-applied failed
  operations, never inflight/uncertain/synced. Cancelled dependencies block children.
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

## Integration ownership

Router uses `isGithubOutboxCommand`, `isGithubOutboxControl`,
`isGithubOutboxHeartbeat`, `isGithubPrScope` on unknown input; no unchecked casts.
Worker implements `GithubOutbox`; direct API owner implements
`GithubOutboxAdapter`; browser owner implements `GithubOutboxJournal` and projects
snapshots with local entity refs alongside existing remote comments. Keep existing
read models (`PRComment`/`IssueComment`) separate; they lack stable actor IDs and
cannot be used as identity evidence. Existing `Gh` mutation signatures are not this
adapter contract and should not constrain its stronger safety checks.
