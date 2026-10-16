# Browser checks

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:review-transport
```

Linux CI installs OS dependencies with `pnpm exec playwright install --with-deps chromium`.
The root dev dependency is `playwright`; the root script is
`"test:browser": "node scripts/test-browser.mjs"`.

## Contracts

- The runner starts its own Vite server on a random loopback port. It never opens
  an existing development page, starts the backend, or reads the development API token.
- Its separate Vite config disables env-file loading, the development API proxy,
  HMR, and remote font loading. Browser requests to APIs, external hosts, and
  non-GET endpoints are blocked and fail the case if a local fixture did not intercept them.
- Each case gets a fresh Chromium context (including fresh cookies, localStorage,
  IndexedDB, selection state, module globals and query caches). Cases run serially
  in sorted file/export order. Browser errors and 30-second case timeouts fail the run.
- `src/**/*.browser.ts` and `src/**/*.browser.tsx` exports named
  `test*InBrowser` are discovered automatically. Return an object with a positive
  `passed` assertion count; throw to fail. An empty discovery is a failure.
- The App navigation fixture runs all six offline modes against the real mounted
  App, with synthetic PR data and transport fixtures. Its `live-source` mode is
  intentionally excluded: that diagnostic requires a real saved session/backend.
- The exported dismissal mount helper is additionally exercised using trusted
  Playwright pointer and keyboard input, not just synthetic DOM events.
- Source-navigation fixtures require actual bounded ranges and return sliced
  content with `totalLines`, `contentStartLine`, and `contentEndLine`. Missing or
  oversized range requests fail rather than falling back to full-file responses.
- Source interaction cases exercise rendered earlier/later page controls, file
  boundaries, absolute native text selections, ambiguous candidate provenance,
  captured historical source, and actual tRPC AbortSignal propagation. Two source
  views share a manually released mock immutable load to verify cancelling one
  reader does not abort the other; real backend cache behavior is covered by the
  backend tests, not claimed by this browser mock.
- The real interaction owner, source view, anchored question editor and inline
  comment form are exercised together. Question drafts survive source paging and
  closure, new/saved delivery retries retain admission keys, and changed revisions
  block question/comment submission without discarding drafts.
- Browser and server shutdown runs after success, failure, SIGINT and SIGTERM.

## Layout and reports

`artifacts/browser/results.json` contains each case's result. Failed cases also
save a page screenshot (fixtures may already have cleaned up their DOM).

The narrow-chat case asserts no transcript overflow at 240/320/600px, local code
scrolling, and correct collapsed/expanded line counts using production CSS and
`SelectionQuestionMessage`. Six screenshots of ordinary/selected-source messages
are saved as `chat-*-{collapsed,expanded}.png`. These are **review artifacts, not
approved pixel baselines**. Fonts use the offline system fallback, so screenshots
can differ across operating systems. This case does not substitute for full-page
ChatPanel visual coverage.

The GitHub workflow installs Chromium, runs unit tests, lint/format checks and all
package TypeScript checks, executes the browser suite and web build, and uploads
browser artifacts even on failure.
No paid model calls, GitHub comment posts, real PR data or user browser profiles
are needed.

## HTTP/1.1 review transport

`pnpm test:review-transport` starts an isolated HTTP/1.1 Vite server with local
snapshot, persistent SSE, and mock write endpoints. Eight Chromium pages share
one context/origin and use the production review client (no fetch interception).
A negative control first proves six uncapped streams block browser requests.
The capped client must keep at most two streams, hydrate all eight viewers, and
leave mock GitHub replies, review admission, health reads and navigation working.
The runner also checks released-slot handoff, visibility pause/resume, EOF and
failed-fetch recovery, disposal, no-Web-Locks polling, cancellation of old polls,
and settlement through the actual chat hook. It never reads the development
token or contacts real GitHub/model services.
