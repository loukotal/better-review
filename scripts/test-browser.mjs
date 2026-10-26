import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { tsImport } from "tsx/esm/api";

import { createBrowserGithubActions } from "./browser-github-actions.mjs";
import { createBrowserGithubHttp } from "./browser-github-http.mjs";
import { createBrowserNestedReplies } from "./browser-nested-replies.mjs";
import config from "./browser-vite.config.mjs";

// The browser contract test consumes real resolver output, not a reimplementation
// of the backend's newline/range serialization in a fetch mock.
const { resolveSourceNavigation } = await tsImport(
  "../packages/better-review/src/source-navigation.ts",
  import.meta.url,
);
const { decodeGithubReviewComments, decodeGithubReviewStatus } = await tsImport(
  "../packages/better-review/src/gh/gh.ts",
  import.meta.url,
);

const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const { createServer } = await import(requireWeb.resolve("vite"));
const { chromium } = await import("playwright");
const artifacts = fileURLToPath(new URL("../artifacts/browser/", import.meta.url));
await mkdir(artifacts, { recursive: true });
let server, browser;
const results = [];
async function cleanup() {
  try {
    await browser?.close();
  } finally {
    await server?.close();
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });

async function open() {
  let githubHttp;
  const githubHttpReceipts = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const violations = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (githubHttp && url.origin === origin && url.pathname.startsWith("/api/trpc/githubOutbox.")) {
      const backend = await githubHttp;
      const response = await route.fetch({
        url: `${backend.origin}${url.pathname}${url.search}`,
        maxRedirects: 0,
        timeout: 10_000,
      });
      if (url.pathname === "/api/trpc/githubOutbox.enqueue")
        githubHttpReceipts.push({ status: response.status(), body: await response.text() });
      // Reverse proxy exact HTTP bytes. No procedure decoding or response reconstruction.
      return route.fulfill({ response });
    }
    if (url.origin === origin && !url.pathname.startsWith("/api/") && request.method() === "GET")
      return route.continue();
    violations.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  await page.exposeFunction("copyBrowserFeedback", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.getByRole("button", { name: "Review actions", exact: true }).click();
    await page.getByText("Copy feedback", { exact: true }).click();
    await page.getByText("Feedback copied.", { exact: true }).waitFor();
    return page.evaluate(() => navigator.clipboard.readText());
  });
  await page.exposeFunction("setBrowserMotionPreference", async (reducedMotion) => {
    await page.emulateMedia({ reducedMotion });
  });
  await page.exposeFunction("dismissBrowserPopover", async (kind) => {
    if (kind === "escape") await page.keyboard.press("Escape");
    else await page.mouse.click(2, 2);
  });
  await page.exposeFunction("clickAndTypeBrowserControl", async (selector, text) => {
    await page.locator(selector).click();
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Review settings"]:popover-open'),
    );
    await page.keyboard.type(text);
  });
  await page.exposeFunction("captureBrowserGithubComment", async () => {
    await page.locator('[data-github-comment-key="remote:issue-comment:10"]').screenshot({
      path: `${artifacts}/github-pending-comment.png`,
      animations: "disabled",
    });
  });
  await page.exposeFunction("typeBrowserGithubEditor", async (key, text) => {
    const editor = page.locator(`[data-github-comment-key="${key}"] textarea`);
    await editor.fill(text);
    await editor.press("ArrowLeft");
    await editor.press("Shift+ArrowLeft");
    await editor.press("Shift+ArrowLeft");
  });
  await page.exposeFunction("clickBrowserGithubCommentButton", async (key, label) => {
    await page
      .locator(`[data-github-comment-key="${key}"]`)
      .getByRole("button", { name: label, exact: true })
      .click();
  });
  await page.exposeFunction("typeInFocusedBrowserEditor", async (text) => {
    await page.keyboard.type(text);
  });
  await page.exposeFunction("activateBrowserLinkWithEnter", async (selector) => {
    await page.locator(selector).press("Enter");
  });
  let githubActions;
  let nestedReplies;
  await page.exposeFunction("browserNestedReplies", async (request) => {
    nestedReplies ??= createBrowserNestedReplies();
    return (await nestedReplies).invoke(request);
  });
  await page.exposeFunction("browserGithubActions", async (request) => {
    githubActions ??= createBrowserGithubActions();
    return (await githubActions).invoke(request);
  });
  await page.exposeFunction("browserGithubHttp", async ({ kind }) => {
    if (kind === "start") {
      githubHttp ??= createBrowserGithubHttp();
      const backend = await githubHttp;
      return { token: backend.token, pid: backend.pid };
    }
    if (!githubHttp) throw new Error("HTTP composition fixture has not started");
    const backend = await githubHttp;
    if (kind === "close") return backend.close();
    const value = await backend.invoke(kind);
    return kind === "inspect" ? { ...value, httpReceipts: githubHttpReceipts } : value;
  });
  context.on("close", () => {
    void githubActions?.then((actions) => actions.close());
    void nestedReplies?.then((actions) => actions.close());
  });
  await page.exposeFunction("decodeBrowserGithubReviewComments", decodeGithubReviewComments);
  await page.exposeFunction("decodeBrowserGithubReviewStatus", decodeGithubReviewStatus);
  await page.exposeFunction("resolveBrowserSourceWindow", (content, range) => {
    const ref = "a".repeat(40),
      path = "src/contract.ts";
    return resolveSourceNavigation(
      { path, ref, currentRef: ref, allowedRefs: [ref], line: range.startLine, range },
      { files: async () => [path], read: async () => content, renames: async () => [] },
    );
  });
  await page.exposeFunction("captureBrowserLayout", async (name) => {
    if (!/^chat-\d+-(expanded|collapsed)$/.test(name)) throw new Error("Invalid screenshot name");
    await page
      .locator("#browser-layout-capture")
      .screenshot({ path: `${artifacts}/${name}.png`, animations: "disabled" });
  });
  await page.exposeFunction("captureBrowserQueueLayout", async (name) => {
    if (name !== undefined && !["stuck-before", "stuck-after", "consent-320"].includes(name))
      throw new Error("Invalid queue screenshot name");
    await page.setViewportSize(
      name === "consent-320" ? { width: 320, height: 400 } : { width: 390, height: 844 },
    );
    await page.screenshot({
      path: `${artifacts}/${name === "consent-320" ? "github-queue-consent-320x400" : name ? `github-queue-${name}-390` : "github-queue-compact-390"}.png`,
      animations: "disabled",
    });
  });
  await page.exposeFunction("setBrowserQueueViewport", async (width = 390, height = 844) => {
    if (!((width === 390 && height === 844) || (width === 320 && height === 400)))
      throw new Error("Invalid queue viewport");
    await page.setViewportSize({ width, height });
  });
  await page.exposeFunction("clickBrowserQueueActionButton", async (operationId, label) => {
    if (
      !/^[a-f0-9-]{36}$/.test(operationId) ||
      ![
        "Check GitHub",
        "Retry",
        "Clear",
        "Allow manual retry…",
        "I checked GitHub — allow retry",
      ].includes(label)
    )
      throw new Error("Invalid queue action click");
    await page
      .locator(`[popover]:popover-open [data-operation-id="${operationId}"]`)
      .getByRole("button", { name: label, exact: true })
      .click();
  });
  await page.exposeFunction("clickBrowserQueueBatch", async (kind) => {
    if (!["retry", "clear"].includes(kind)) throw new Error("Invalid queue batch click");
    await page.locator(`[popover]:popover-open [data-github-queue-batch="${kind}"]`).click();
  });
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await page.goto(`${origin}/browser-tests.html`);
  await page.waitForFunction(() => !!window.browserTests);
  return {
    context,
    page,
    violations,
    errors,
    closeGithubHttp: async () => {
      if (githubHttp) await (await githubHttp).close();
    },
  };
}
let origin;
async function trustedDismissal(page) {
  await page.evaluate(() => window.browserTests.mountDismissal());
  let passed = 0;
  await page.getByRole("button", { name: "Open contract dialog", exact: true }).click();
  await page.getByRole("button", { name: "Keep dialog open", exact: true }).click();
  assert.equal(await page.evaluate(() => window.browserTests.dismissalCount()), 0);
  passed++;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.browserTests.dismissalCount() === 1);
  passed++;
  await page.getByRole("button", { name: "Open contract dialog", exact: true }).click();
  await page.mouse.click(2, 2);
  await page.waitForFunction(() => window.browserTests.dismissalCount() === 2);
  passed++;
  await page.getByRole("button", { name: "Contract popover", exact: true }).click();
  await page.getByRole("button", { name: "Keep popover open", exact: true }).click();
  assert.equal(await page.locator("[popover]:popover-open").count(), 1);
  passed++;
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[popover]:popover-open"));
  passed++;
  await page.evaluate(() => window.browserTests.disposeDismissal());
  return { passed };
}
async function durableDraftReload(page, test) {
  if (test.name === "testAppDurableGithubHttpCompositionInBrowser") {
    let passed = 0;
    let latest;
    for (const mode of ["before", "resume", "after"]) {
      if (mode !== "before") await reloadFixturePage(page);
      latest = await page.evaluate((test) => window.browserTests.run(test), { ...test, mode });
      passed += latest.passed;
    }
    return { ...latest, passed };
  }
  const first = await page.evaluate(
    (test) => window.browserTests.run({ ...test, mode: "before" }),
    test,
  );
  await reloadFixturePage(page);
  const second = await page.evaluate(
    (test) => window.browserTests.run({ ...test, mode: "after" }),
    test,
  );
  return { ...second, passed: first.passed + second.passed };
}
async function reloadFixturePage(page) {
  // Reload the fixture document, not the live app entrypoint. Retain the same
  // context's IndexedDB/localStorage/sessionStorage and any fixture backend.
  await page.evaluate(() => history.replaceState(null, "", "/browser-tests.html"));
  await page.reload();
  await page.waitForFunction(() => !!window.browserTests);
}
try {
  server = await createServer({ ...config, configFile: false });
  await server.listen();
  origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ headless: true });
  const discovery = await open();
  const discovered = await discovery.page.evaluate(() => window.browserTests.list());
  for (const name of [
    "testModelRestoreFailurePreservesIntentInBrowser",
    "testModelBackendWinsOverStaleBrowserInBrowser",
    "testModelQueryFailurePreservesIntentInBrowser",
    "testModelRapidReviewWaitsForHydrationInBrowser",
    "testModelQuestionKeepsModelThroughSessionCreationInBrowser",
    "testModelBrowserCacheFailureDoesNotBlockBackendSelectionInBrowser",
    "testModelListReviewWaitsForLegacyMigrationInBrowser",
  ]) {
    const matches = discovered.filter((test) => test.name === name);
    assert.equal(matches.length, 1, `${name} must be discovered exactly once`);
    assert.equal(matches[0].file, "./model-selection.browser.tsx");
  }
  console.log(`Discovered ${discovered.length} browser cases; all seven model cases registered`);
  const tests = discovered.filter(
    (test) =>
      !process.env.BROWSER_TEST_FILTER ||
      `${test.file}#${test.name}`.includes(process.env.BROWSER_TEST_FILTER),
  );
  await discovery.context.close();
  assert.ok(tests.length > 0, "No browser fixtures discovered");
  for (const [index, test] of tests.entries()) {
    const label = `${test.file}#${test.name}${test.mode ? `:${test.mode}` : ""}`;
    let fixture;
    let timer;
    try {
      fixture = await open();
      const result = await Promise.race([
        test.kind === "trusted-dismissal"
          ? trustedDismissal(fixture.page)
          : [
                "testAppGithubDraftIntentReloadInBrowser",
                "testAppGithubFailedSaveReloadInBrowser",
                "testAutomaticReviewOrderReloadInBrowser",
                "testPrDetailMergeReloadInBrowser",
                "testAppNestedReviewRepliesInBrowser",
                "testAppDurableGithubHttpCompositionInBrowser",
              ].includes(test.name)
            ? durableDraftReload(fixture.page, test)
            : fixture.page.evaluate((test) => window.browserTests.run(test), test),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Fixture exceeded 30 seconds")), 30_000);
          timer.unref();
        }),
      ]);
      if (fixture.violations.length || fixture.errors.length)
        throw new Error([...fixture.violations, ...fixture.errors].join("\n"));
      console.log(`PASS ${label} (${result.passed} assertions)`);
      if (result.evidence) console.log(`Composition evidence: ${JSON.stringify(result.evidence)}`);
      results.push({ label, status: "passed", result });
    } catch (error) {
      console.error(`FAIL ${label}\n${error.stack || error}`);
      results.push({
        label,
        status: "failed",
        error: String(error),
        blockedRequests: fixture?.violations,
        pageErrors: fixture?.errors,
      });
      await fixture?.page
        .screenshot({ path: `${artifacts}/${index}-failure.png`, fullPage: true })
        .catch(() => {});
    } finally {
      clearTimeout(timer);
      await fixture?.context.close();
      await fixture?.closeGithubHttp();
    }
  }
  const failures = results.filter((r) => r.status === "failed").length;
  console.log(`Browser tests: ${results.length - failures}/${results.length} passed`);
  if (failures) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await writeFile(`${artifacts}/results.json`, JSON.stringify(results, null, 2));
  } finally {
    await cleanup();
  }
}
