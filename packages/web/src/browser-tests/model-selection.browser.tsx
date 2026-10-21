import { render } from "solid-js/web";
import superjson from "superjson";

import { ChatPanel } from "../ChatPanel";
import { ModelSelector } from "../components/ModelSelector";
import type { SelectionChatController } from "../lib/ask-ai-selection";
import "../index.css";
import { mountAppFixture } from "./mount-app";

const key = "better-review:selected-model";
const selected = {
  providerId: "openai-codex",
  modelId: "gpt-6.1-sol",
  name: "Chosen model",
  reasoning: true,
  thinkingLevels: ["medium", "high"] as const,
  variants: [],
  releaseDate: "",
  variant: null,
  thinkingLevel: "high",
};
const old = { ...selected, modelId: "gpt-5.5" };
const saved = JSON.stringify(selected);
const snapshot = {
  sessionId: "model-test",
  messages: [],
  settlements: [],
  running: false,
  compacting: false,
};

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function wait(predicate: () => boolean, message: string) {
  const until = performance.now() + 5000;
  while (!predicate() && performance.now() < until) await new Promise(requestAnimationFrame);
  check(predicate(), message);
}
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function success(value: unknown) {
  return Response.json({ result: { data: superjson.serialize(value) } });
}
function failure(message: string) {
  return Response.json(
    {
      error: superjson.serialize({
        message,
        code: -32600,
        data: { code: "BAD_REQUEST", httpStatus: 400 },
      }),
    },
    { status: 400 },
  );
}
function mount(
  procedure: (name: string, input: unknown, method: string) => Promise<Response>,
  chat = false,
) {
  localStorage.setItem(key, saved);
  const original = window.fetch;
  const requests: string[] = [];
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname.startsWith("/api/trpc/")) {
      const payload = superjson.deserialize(
        JSON.parse(init?.body ? String(init.body) : (url.searchParams.get("input") ?? "{}")),
      );
      const name = url.pathname.split("/").at(-1)!;
      if (name === "prReview.getOrCreateSession")
        return success({
          session: { id: "model-test" },
          sessions: [],
          headSha: "a".repeat(40),
          sessionHeadSha: "a".repeat(40),
        });
      return procedure(name, payload, method);
    }
    if (url.pathname === "/api/review/sessions/model-test/events")
      return new Response(
        `event: snapshot\ndata: ${JSON.stringify({ version: 0, snapshot })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    if (url.pathname === "/api/review/sessions/model-test" && method === "GET")
      return Response.json(snapshot);
    if (url.pathname === "/api/review/sessions/model-test" && method === "POST")
      return procedure("admit", JSON.parse(String(init?.body)), method);
    throw new Error(`Unexpected offline request: ${method} ${url.pathname}`);
  };
  const host = document.createElement("div");
  document.body.append(host);
  let ready = false;
  let controller: SelectionChatController | null = null;
  const dispose = render(
    () =>
      chat ? (
        <ChatPanel
          prUrl="https://github.com/fixture/offline/pull/1"
          prNumber={1}
          repoOwner="fixture"
          repoName="offline"
          files={[]}
          theme="github-light"
          selectionScope="offline"
          onSelectionController={(value) => {
            controller = value;
          }}
        />
      ) : (
        <ModelSelector
          onStateChange={(state) => {
            ready = state.ready;
          }}
        />
      ),
    host,
  );
  return {
    host,
    requests,
    ready: () => ready,
    controller: () => controller,
    close() {
      dispose();
      host.remove();
      window.fetch = original;
    },
  };
}

async function restoreFailurePreservesIntent() {
  let currentCalls = 0,
    restoreCalls = 0,
    reject = true;
  const fixture = mount(async (name) => {
    if (name === "models.current") {
      currentCalls++;
      return success({ ...old, selectionSource: "default" });
    }
    if (name === "models.restoreCurrent") {
      restoreCalls++;
      return reject ? failure("Chosen model requires credentials") : success({ model: selected });
    }
    throw new Error(`Unexpected procedure ${name}`);
  });
  try {
    await wait(() => !!fixture.host.querySelector('[role="alert"]'), "Restore error not shown");
    check(!fixture.ready(), "Failed restoration admitted reviews");
    check(
      localStorage.getItem(key) === saved,
      "Restore failure erased or replaced explicit intent",
    );
    check(currentCalls === 1 && restoreCalls === 1, "Restore failure fetched/saved a fallback");
    check(
      fixture.host.textContent?.includes("requires credentials") &&
        fixture.host.textContent.includes("Reviews are blocked"),
      "Restore error is not actionable",
    );
    reject = false;
    [...fixture.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Retry model selection"))!
      .click();
    await wait(fixture.ready, "Retry did not restore chosen model");
    check(
      JSON.parse(localStorage.getItem(key)!).modelId === selected.modelId,
      "Retry changed requested model",
    );
  } finally {
    fixture.close();
  }
}

async function backendWinsOverStaleBrowser() {
  let writes = 0;
  const query = held();
  const fixture = mount(async (name) => {
    if (name === "models.current") {
      await query.promise;
      return success({ ...old, selectionSource: "saved" });
    }
    writes++;
    throw new Error("Browser must not overwrite a saved backend choice");
  });
  try {
    check(!fixture.ready(), "Held query marked selection ready");
    check(localStorage.getItem(key) === saved, "Pending query mutated intent");
    query.release();
    await wait(fixture.ready, "Authoritative backend selection not loaded");
    check(writes === 0, "Stale browser issued selection mutation");
    check(
      JSON.parse(localStorage.getItem(key)!).modelId === old.modelId,
      "Browser did not adopt authoritative selection",
    );
  } finally {
    query.release();
    fixture.close();
  }
}

async function queryFailurePreservesIntent() {
  let requests = 0;
  const fixture = mount(async (name) => {
    requests++;
    check(name === "models.current", "Failed query triggered a fallback mutation");
    return failure("Saved backend model is unavailable. Select a model again.");
  });
  try {
    await wait(() => !!fixture.host.querySelector('[role="alert"]'), "Query failure not visible");
    check(!fixture.ready() && requests === 1, "Query failure was silently accepted");
    check(localStorage.getItem(key) === saved, "Query error overwrote browser intent");
  } finally {
    fixture.close();
  }
}

async function rapidReviewWaitsForHydration() {
  const query = held(),
    restore = held();
  let queried = false,
    restoring = false;
  let rejectRestore = true;
  let serverModel = old.modelId;
  const admissions: string[] = [];
  const fixture = mount(async (name, input) => {
    if (name === "models.current") {
      queried = true;
      await query.promise;
      return success({ ...old, selectionSource: "default" });
    }
    if (name === "models.restoreCurrent") {
      restoring = true;
      check(
        (input as typeof selected).modelId === selected.modelId,
        "Migration requested wrong model",
      );
      await restore.promise;
      if (rejectRestore) return failure("Chosen model is unavailable. Choose a model again.");
      serverModel = selected.modelId;
      return success({ model: selected });
    }
    if (name === "admit") {
      admissions.push(serverModel);
      return Response.json({ submissionId: "1" });
    }
    throw new Error(`Unexpected procedure ${name}`);
  }, true);
  try {
    await wait(
      () => queried && !!fixture.host.querySelector("form"),
      "Chat/model query did not mount",
    );
    const textarea = fixture.host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message review assistant"]',
    )!;
    const form = fixture.host.querySelector("form")!;
    const forceSubmit = () => {
      textarea.value = "Review now";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    };
    check(
      textarea.disabled && fixture.controller()?.disabled(),
      "Chat enabled before server selection loaded",
    );
    check(
      (await fixture.controller()!.send(
        {
          draftId: "held-model",
          file: "example.ts",
          side: "RIGHT",
          startLine: 1,
          endLine: 1,
          text: "const chosen = true;",
          revision: "a".repeat(40),
          scope: "offline",
        },
        "Explain",
        "model-test",
        () => true,
      )) === false,
      "Source-selection controller bypassed model readiness",
    );
    forceSubmit();
    await new Promise(requestAnimationFrame);
    check(admissions.length === 0, "Prompt admitted while model query was held");
    query.release();
    await wait(() => restoring, "Browser migration not started");
    check(textarea.disabled, "Chat enabled before browser migration completed");
    forceSubmit();
    await new Promise(requestAnimationFrame);
    check(admissions.length === 0, "Prompt admitted while restoration was held");
    restore.release();
    await wait(
      () => !!fixture.host.querySelector('[role="alert"]'),
      "Chat did not expose failed model restoration",
    );
    check(
      textarea.disabled && localStorage.getItem(key) === saved,
      "Failed restore lost intent or unlocked chat",
    );
    forceSubmit();
    await new Promise(requestAnimationFrame);
    check(admissions.length === 0, "Failed restoration admitted a default-model prompt");
    [...fixture.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Open model settings"))!
      .click();
    rejectRestore = false;
    [...fixture.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Retry model selection"))!
      .click();
    await wait(() => !textarea.disabled, "Chat did not unlock after confirmed selection");
    forceSubmit();
    await wait(() => admissions.length === 1, "Confirmed prompt was not admitted");
    check(admissions[0] === selected.modelId, "Rapid review ran the default model");
  } finally {
    query.release();
    restore.release();
    fixture.close();
  }
}

async function questionKeepsModelThroughSessionCreation() {
  const originalSet = Storage.prototype.setItem;
  const creation = held();
  let creating = false;
  let switched = false;
  let globalModel = selected.modelId;
  const admitted: string[] = [];
  const fixture = mount(async (name, input) => {
    if (name === "models.current") return success({ ...selected, selectionSource: "saved" });
    if (name === "prReview.create") {
      creating = true;
      await creation.promise;
      return success({ session: { id: "model-test" }, sessions: [] });
    }
    if (name === "prReview.switch") {
      switched = true;
      return success({ session: { id: "model-test" } });
    }
    if (name === "admit") {
      const request = input as { model?: { modelId: string } };
      admitted.push(request.model?.modelId ?? globalModel);
      return Response.json({ submissionId: "question-1" });
    }
    throw new Error(`Unexpected procedure ${name}`);
  }, true);
  Storage.prototype.setItem = function (storageKey, value) {
    if (storageKey === key) throw new DOMException("Storage denied", "SecurityError");
    return originalSet.call(this, storageKey, value);
  };
  try {
    await wait(
      () => !!fixture.controller() && !fixture.controller()!.disabled(),
      "Question model not hydrated",
    );
    const sending = fixture.controller()!.send(
      {
        draftId: "captured-model-question",
        file: "example.ts",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        text: "const value = 1;",
        revision: "a".repeat(40),
        scope: "offline",
      },
      "Explain",
      "new",
      () => true,
    );
    await wait(() => creating, "Question did not wait on new-session creation");
    globalModel = old.modelId; // Another tab changes the global selection while this intent waits.
    creation.release();
    check(await sending, "Question was not admitted");
    await wait(() => switched, "Question did not finish updating its session selection");
    check(
      admitted.length === 1 && admitted[0] === selected.modelId,
      "Pending question used the later global model",
    );
  } finally {
    creation.release();
    Storage.prototype.setItem = originalSet;
    fixture.close();
  }
}

async function browserCacheFailureDoesNotBlockBackendSelection() {
  let failQuery = true;
  const originalSet = Storage.prototype.setItem;
  const fixture = mount(async (name) => {
    if (name === "models.current")
      return failQuery
        ? failure("Temporary model lookup error")
        : success({ ...selected, selectionSource: "saved" });
    if (name === "models.search") return success({ models: [old], connectedProvidersCount: 1 });
    if (name === "models.setCurrent") return success({ model: old });
    throw new Error(`Unexpected procedure ${name}`);
  });
  try {
    await wait(
      () => !!fixture.host.querySelector('[role="alert"]'),
      "Expected lookup error missing",
    );
    Storage.prototype.setItem = function (storageKey, value) {
      if (storageKey === key)
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      return originalSet.call(this, storageKey, value);
    };
    failQuery = false;
    [...fixture.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Retry model selection"))!
      .click();
    await wait(fixture.ready, "Browser cache fault blocked a successful backend hydration retry");
    fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Choose model"]')!.click();
    await wait(
      () =>
        [...fixture.host.querySelectorAll("button")].some((button) =>
          button.textContent?.includes(old.modelId),
        ),
      "Model search did not load",
    );
    [...fixture.host.querySelectorAll("button")]
      .find((button) => button.textContent?.includes(old.modelId))!
      .click();
    await wait(
      () => fixture.ready() && fixture.host.textContent?.includes(old.modelId) === true,
      "Browser cache fault blocked an explicit backend selection",
    );
    check(
      !fixture.host.querySelector('[role="alert"]'),
      "Cache fault presented as a model failure",
    );
  } finally {
    Storage.prototype.setItem = originalSet;
    fixture.close();
  }
}

async function listReviewWaitsForLegacyMigration() {
  localStorage.setItem(key, saved);
  const query = held(),
    migration = held();
  let queried = false,
    restoring = false,
    reject = true;
  const admissions: string[] = [];
  const url = "https://github.com/browser-fixture/isolated/pull/1";
  const dispose = await mountAppFixture({
    initialPath: "/?needsReview=0",
    waitForFiles: false,
    procedures: {
      "prs.list": () => ({
        prs: [
          {
            number: 1,
            headRefOid: "a".repeat(40),
            title: "Model migration fixture",
            url,
            repository: { name: "isolated", nameWithOwner: "browser-fixture/isolated" },
            author: { login: "browser-fixture" },
            createdAt: "2026-01-01T00:00:00Z",
            isDraft: false,
            myReviewState: null,
            isAuthor: false,
            reviewRequested: true,
            additions: 1,
            deletions: 1,
            ciStatus: null,
          },
        ],
        fetchedAt: Date.now(),
      }),
      "prs.ciStatusBatch": () => ({ statuses: {} }),
      "prReview.automaticStatuses": () => ({ [url]: { state: "none" } }),
      "models.current": async () => {
        queried = true;
        await query.promise;
        return { ...old, selectionSource: "default" };
      },
      "models.restoreCurrent": async () => {
        restoring = true;
        await migration.promise;
        if (reject) throw new Error("Chosen model requires credentials");
        return { model: selected };
      },
      "prReview.startAutomatic": (input) => {
        admissions.push((input as { model: { modelId: string } }).model.modelId);
        return { state: "running", sessionId: "model-list", headSha: "a".repeat(40) };
      },
    },
  });
  try {
    await wait(
      () => !!document.querySelector('button[aria-label="Review PR 1"]'),
      "List Review action did not render",
    );
    document.querySelector<HTMLButtonElement>('button[aria-label="Review PR 1"]')!.click();
    await wait(() => queried, "List launch skipped shared model hydration");
    check(admissions.length === 0, "List admitted default while model query was held");
    query.release();
    await wait(() => restoring, "List launch skipped legacy browser migration");
    check(admissions.length === 0, "List admitted default while migration was held");
    migration.release();
    await wait(
      () => !!document.querySelector('button[aria-label="Retry review PR 1"]'),
      "Failed migration did not offer list recovery",
    );
    check(
      admissions.length === 0 && localStorage.getItem(key) === saved,
      "Failed list restoration admitted fallback or lost intent",
    );
    reject = false;
    document.querySelector<HTMLButtonElement>('button[aria-label="Retry review PR 1"]')!.click();
    await wait(() => admissions.length === 1, "Retry did not launch with confirmed model");
    check(admissions[0] === selected.modelId, "List review ignored migrated model");
  } finally {
    query.release();
    migration.release();
    dispose();
  }
}

declare global {
  interface Window {
    runModelSelectionTests: () => Promise<string[]>;
  }
}
window.runModelSelectionTests = async () => {
  const passed: string[] = [];
  for (const test of [
    restoreFailurePreservesIntent,
    backendWinsOverStaleBrowser,
    queryFailurePreservesIntent,
    rapidReviewWaitsForHydration,
    questionKeepsModelThroughSessionCreation,
    browserCacheFailureDoesNotBlockBackendSelection,
    listReviewWaitsForLegacyMigration,
  ]) {
    await test();
    passed.push(test.name);
  }
  return passed;
};
