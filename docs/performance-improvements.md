# Review performance and verification

## Source lookup

Git-object lookup caches are keyed by canonical repository path and immutable
revision. Completed trees, blobs, rename mappings, and comparison results share
an estimated 32 MiB / 256-entry LRU budget. Concurrent requests share reads;
cancelling one caller stops its wait without cancelling another caller's read.
Errors and missing objects remain retryable.

The inline source viewer requests 200-line windows. Paging and text selections
retain absolute source line numbers. Original source provenance remains separate
from a fallback destination; choosing a candidate does not make an approximate
match exact.

Local measurements used a fixed bare Git repository with 5,000 paths and a
100,000-line, 3,277,780-byte file:

| Measurement                                       |          Before |       After |
| ------------------------------------------------- | --------------: | ----------: |
| First lookup                                      |        47.43 ms |    55.23 ms |
| Warm lookup, upper median of 20                   |        47.87 ms |     3.83 ms |
| Serialized full response versus 200-line response | 3,377,945 bytes | 7,033 bytes |

First lookup means process/cache-cold, not filesystem-cold. These are fixture
measurements, not production latency guarantees. The cache budget covers retained
entries, not concurrent Git output or total process memory.

## Transcript projection

Ordinary entry appends update the projected history incrementally. Late tool
results replace their message copy-on-write, preserving prior snapshots.
Submission settlements do not rebuild unchanged message history. Replacement
and out-of-order records use a replay path.

`packages/better-review/src/review/projection.bench.ts` measures dirty snapshot
projection after warmup. Every sample verifies that its committed entry appears
in the snapshot. One independent local run measured a 0.0084 ms median and
0.0232 ms p95 over 100 samples. This synthetic append-only measurement excludes
database commits, initial hydration, response serialization, live overlays, and
exceptional replay. It is not end-to-end review latency.

Message-array copying, settlement scans, and live-tool lookups still grow with
conversation size. Index memory also grows with the retained transcript.

## Syntax highlighting

The completed highlighting cache has 500-entry and 8 MiB limits, including UTF-8
key and HTML bytes. Concurrent identical requests share a promise. Clearing the
cache prevents older in-flight results from repopulating it. Failed requests can
be retried, and oversized results are returned without being cached.

The budget does not cap active highlighting operations or total JavaScript heap.

## Verification

Run `pnpm test:browser` for isolated Chromium interaction tests, screenshot
artifacts, and nonzero exit on failure. See `scripts/browser-tests.md` for setup,
network isolation, and artifacts. Screenshots are inspection artifacts, not
approved visual baselines.

The CI workflow runs unit tests, all package typechecks, lint, formatting,
browser tests, and the production web build. Real microVM checks remain opt-in:

```sh
BETTER_REVIEW_SANDBOX_TEST=1 node --import tsx --test packages/better-review/src/review/microsandbox.integration.test.ts packages/better-review/src/review/structured-tools.integration.test.ts
```

For model-level review-quality and token comparisons, use the fixed-revision
procedure in [review-tool-evaluation.md](review-tool-evaluation.md).
