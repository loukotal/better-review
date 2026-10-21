import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { chromium } from "playwright";

import config from "./browser-vite.config.mjs";

const requireWeb = createRequire(new URL("../packages/web/package.json", import.meta.url));
const { createServer } = await import(requireWeb.resolve("vite"));
const server = await createServer(config);
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/model-selection-tests.html`);
  try {
    await page.waitForFunction(() => !!window.runModelSelectionTests);
  } catch (cause) {
    throw new Error(`Model test entry failed to load: ${JSON.stringify(errors)}`, { cause });
  }
  const passed = await page.evaluate(() => window.runModelSelectionTests());
  assert.deepEqual(violations, [], "All tests must stay offline");
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(JSON.stringify({ passed }));
} finally {
  await browser?.close();
  await server.close();
}
