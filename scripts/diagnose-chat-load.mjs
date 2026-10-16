import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { chromium } from "playwright";

// Live navigation probe: intercepts model submissions and GitHub writes. Normal
// getOrCreateSession/selectSession calls still reach the server and can create
// local session records, prepare checkouts, or change the active conversation.
const origin = process.env.CHAT_REPRO_ORIGIN ?? "http://localhost:3000";
const prUrl = "https://github.com/MyZenbase/zenbase/pull/16204";
const sessionId = "9f27e636-73a1-4f2c-93cd-6a185fca394b";
const token = (
  await readFile(new URL("../.better-review-api-token", import.meta.url), "utf8")
).trim();
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const modes = process.env.CHAT_REPRO_CONNECTION_LIMIT
    ? ["connection-limit"]
    : process.env.CHAT_REPRO_SUBMIT
      ? ["reply-click", "reply-shortcut", "assistant-click", "assistant-shortcut"]
      : ["saved-link", "current-session", "list-navigation"];
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    await context.addInitScript(
      (value) => localStorage.setItem("better-review.apiToken", value),
      token,
    );
    const page = await context.newPage();
    const held = [];
    // Never let a diagnostic reply/model submission reach the live server.
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      if (
        request.method() !== "GET" &&
        !/prReview\.(getOrCreateSession|selectSession)$/.test(new URL(request.url()).pathname)
      ) {
        held.push(route);
        return;
      }
      await route.continue();
    });
    const result = { mode, requests: [], errors: [], health: [], heartbeat: null };
    results.push(result);
    page.on("pageerror", (error) => result.errors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error") result.errors.push(message.text());
    });
    page.on("requestfailed", (request) =>
      result.errors.push(`${request.url().split("?")[0]}: ${request.failure()?.errorText}`),
    );
    page.on("request", (request) => {
      if (request.url().includes("/api/"))
        result.requests.push({
          method: request.method(),
          path: new URL(request.url()).pathname,
          at: Date.now(),
        });
    });
    const health = setInterval(async () => {
      const start = performance.now();
      try {
        const response = await fetch(`${origin}/api/review/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000),
        });
        await response.arrayBuffer();
        result.health.push({ status: response.status, ms: Math.round(performance.now() - start) });
      } catch (error) {
        result.health.push({ error: error.message, ms: Math.round(performance.now() - start) });
      }
    }, 1000);
    try {
      if (mode === "list-navigation") {
        await page.goto(origin);
        await page.locator(`a[href*="16204"][href*="showChat=1"]`).first().click();
      } else {
        await page.goto(
          `${origin}/review?prUrl=${encodeURIComponent(prUrl)}&showChat=1${mode !== "current-session" ? `&sessionId=${sessionId}` : ""}`,
        );
      }
      await page
        .locator("#chat-panel")
        .getByText("Adversarial Review: Flinks account checks and payment updates", { exact: true })
        .waitFor({ timeout: 45000 });
      if (mode === "connection-limit") {
        result.transport = await page.evaluate(async (id) => {
          const headers = {
            Authorization: `Bearer ${localStorage.getItem("better-review.apiToken")}`,
          };
          const controllers = Array.from({ length: 5 }, () => new AbortController());
          try {
            await Promise.all(
              controllers.map(async (controller) => {
                await fetch(`/api/review/sessions/${id}/events`, {
                  headers,
                  signal: controller.signal,
                });
              }),
            );
            const start = performance.now();
            let blocked = false;
            try {
              await fetch("/api/app/update-status", { headers, signal: AbortSignal.timeout(3000) });
            } catch {
              blocked = true;
            }
            const blockedMs = Math.round(performance.now() - start);
            controllers.forEach((controller) => controller.abort());
            const recoveryStart = performance.now();
            const recovered = await fetch("/api/app/update-status", {
              headers,
              signal: AbortSignal.timeout(3000),
            });
            return {
              blocked,
              blockedMs,
              recovered: recovered.status,
              recoveryMs: Math.round(performance.now() - recoveryStart),
            };
          } finally {
            controllers.forEach((controller) => controller.abort());
          }
        }, sessionId);
        assert.equal(result.transport.blocked, true, "Expected HTTP/1.1 connection starvation");
        assert.equal(result.transport.recovered, 200);
        // Playwright reports the intentionally timed-out browser request as failed.
        result.errors = result.errors.filter(
          (error) =>
            !error.includes("/api/app/update-status") &&
            !(
              error.includes(`/api/review/sessions/${sessionId}/events`) &&
              error.includes("net::ERR_ABORTED")
            ),
        );
      }
      if (process.env.CHAT_REPRO_SUBMIT) {
        let form;
        if (mode.startsWith("reply")) {
          await page.getByRole("button", { name: "Reply", exact: true }).first().click();
          form = page.getByRole("form", { name: "Reply to comment" });
        } else {
          form = page.locator("#chat-panel form");
        }
        await form
          .getByRole("textbox")
          .fill("Diagnostic intercepted submission; never sent to the server.");
        if (mode.endsWith("shortcut")) await form.getByRole("textbox").press("Meta+Enter");
        else
          await form
            .getByRole("button", { name: mode.startsWith("reply") ? "Reply" : "Send", exact: true })
            .click();
        await page.waitForTimeout(1000);
        assert.equal(held.length, 1, "Submission missing or duplicated");
        await page.getByRole("button", { name: "Files", exact: true }).click();
        await page.getByRole("button", { name: "Files", exact: true }).click();
      }
      await page.waitForTimeout(5000);
      result.heartbeat = await page.evaluate(async () => {
        const start = performance.now();
        await new Promise(requestAnimationFrame);
        return Math.round(performance.now() - start);
      });
      assert.equal(result.errors.length, 0, result.errors.join("\n"));
      assert.ok(
        result.health.length > 0 && result.health.every((sample) => sample.status === 200),
        "Concurrent session health failed",
      );
      const initializations = result.requests.filter((request) =>
        /prReview\.(getOrCreateSession|selectSession)$/.test(request.path),
      );
      assert.equal(initializations.length, 1, "Session initialization repeated");
      result.heldSubmissions = held.map((route) => new URL(route.request().url()).pathname);
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.failure = error.stack ?? error.message;
      result.body = (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(0, 3000);
      process.exitCode = 1;
    } finally {
      clearInterval(health);
      console.log(JSON.stringify(result));
      await context.close();
    }
  }
} finally {
  await browser.close();
  await writeFile(
    new URL("../artifacts/chat-load-diagnosis.json", import.meta.url),
    JSON.stringify(results, null, 2),
  );
}
