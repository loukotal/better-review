# Review request IDs

A request ID belongs to one conversation and one immutable admission intent.
The engine claims it in a durable, latest-only Pi document before configuring
or submitting work. The claim contains a versioned SHA-256 fingerprint of:

- Exact body, including whitespace.
- Effective provider/model and thinking level. Omitted engine thinking means `off`.
- Saved review scope, revisions, changed files, repository identity, checkout
  location, and revision history. Receipt IDs and timestamps are excluded.

An identical retry returns its receipt, including after restart. A changed
intent returns `REVIEW_REQUEST_CONFLICT` with HTTP 409 and never executes.
Admissions serialize configuration through submission. If a crash occurs after
claiming a key but before submission, only the same intent may finish admission.

## Legacy receipts

Pi's old submission records do not themselves retain the original immutable
model/thinking/review-context tuple. When available, the engine reconstructs it
from the exact original user entry and Pi's historical agent and review-session
documents **as of that entry's commit**. Only an exact match may backfill the
fingerprint and return the old receipt. No work runs and no transcript is changed.

Missing/unreadable historical evidence, including unplaced inputs without an
entry, returns HTTP 409 even when the body might match. Current agent settings
and later assistant messages never substitute for original evidence. Unverifiable
requests are not backfilled, overwritten, or resubmitted. Inspect the existing
conversation before deliberately creating a new request.
