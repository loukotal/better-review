import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { tsImport } from "tsx/esm/api";

import config from "./browser-vite.config.mjs";

// The browser contract test consumes real resolver output, not a reimplementation
// of the backend's newline/range serialization in a fetch mock.
const { resolveSourceNavigation } = await tsImport(
  "../packages/better-review/src/source-navigation.ts",
  import.meta.url,
);
const { decodeGithubReviewComments } = await tsImport(
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
    if (url.origin === origin && !url.pathname.startsWith("/api/") && request.method() === "GET")
      return route.continue();
    violations.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  await page.exposeFunction("decodeBrowserGithubReviewComments", decodeGithubReviewComments);
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
  page.setDefaultTimeout(30_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack || error.message));
  await page.goto(`${origin}/browser-tests.html`);
  await page.waitForFunction(() => !!window.browserTests);
  return { context, page, violations, errors };
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
  const first = await page.evaluate(
    (test) => window.browserTests.run({ ...test, mode: "before" }),
    test,
  );
  // The mounted Router changed history to /review. Reload the fixture document,
  // not the live app entrypoint (whose requests must never escape the fixture).
  await page.evaluate(() => history.replaceState(null, "", "/browser-tests.html"));
  await page.reload();
  await page.waitForFunction(() => !!window.browserTests);
  const second = await page.evaluate(
    (test) => window.browserTests.run({ ...test, mode: "after" }),
    test,
  );
  return { passed: first.passed + second.passed };
}
try {
  server = await createServer({ ...config, configFile: false });
  await server.listen();
  origin = server.resolvedUrls.local[0].replace(/\/$/, "");
  browser = await chromium.launch({ headless: true });
  const discovery = await open();
  const tests = await discovery.page.evaluate(() => window.browserTests.list());
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
          : test.name === "testAppGithubDraftIntentReloadInBrowser"
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
