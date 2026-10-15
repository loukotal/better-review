# Evaluating review tools

Use a fixed set of PR revisions to compare the structured tools with the previous
`bash`/`read` workflow. A faster review is useful only if it still finds concrete
defects and cites the right revision and lines.

## Fixtures

Include at least one PR from each category:

- A small change with a known defect and a nearby regression test.
- A cross-file change requiring callers, implementation, and tests to be read.
- A large diff containing renames, generated files, and long lines.
- A clean change, to measure false-positive findings.
- An updated or force-pushed PR with both resolved and outstanding findings.

Record repository identity, base SHA, head SHA, review mode, and any selected
commit. Retain the same immutable revisions for both runs; do not compare against
moving branches. Keep private fixture contents and model responses out of public
benchmark reports.

## Procedure

1. Use the same model, thinking level, prompt, and output limits on both versions.
2. Start each review in a fresh conversation. Preserve the existing conversation
   only when explicitly evaluating revision continuation.
3. Measure cold-cache and warm-cache runs separately. Use a fresh server process
   for cold-cache runs; repeat the same revision in a new conversation for warm
   runs.
4. Run reviews individually when collecting process-local metrics so unrelated
   reviews do not affect the totals. Capture `/api/review/metrics` using the
   application's normal authentication before and after each run.
5. Alternate the two versions and run multiple trials. Report medians and the
   spread, rather than selecting the fastest trial.
6. Inspect the transcript for tool errors, truncation, repeated requests, and
   correct continuation through large results.

## Results

Record these columns for each trial:

| Category   | Measurements                                                                     |
| ---------- | -------------------------------------------------------------------------------- |
| Latency    | Total review time, checkout preparation, first tool, tool execution              |
| Model work | Model requests, input/output tokens, reported cost                               |
| Tool work  | Calls, output bytes, repeated requests, cache hits, truncated responses          |
| Findings   | Known defects found, unsupported findings, correct file/line/revision references |
| Recovery   | Completion after cancellation/retry or revision continuation, where applicable   |

Metric counters and totals can be differenced across snapshots. Means, maxima,
and rolling percentiles cannot be subtracted to obtain per-review values. Record
unavailable measurements as unavailable rather than treating them as zero.
Process-local measurements do not represent exact durable accounting across a
server restart; evaluate restart recovery separately from timing trials.

## Acceptance

- Every known defect found by the baseline remains discoverable, with no increase
  in unsupported findings on the clean fixture.
- Truncated results provide a working continuation; following it does not omit
  or duplicate evidence.
- Changing the reviewed revision cannot return evidence cached for the old one.
- Search failures are distinguishable from successful searches with no matches.
- Report latency/token improvements only after these checks pass. Do not infer
  end-to-end gains from a warm-cache lookup microbenchmark alone.
