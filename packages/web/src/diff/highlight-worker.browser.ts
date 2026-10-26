import {
  FileDiff,
  parseDiffFromFile,
  type DiffHunksRenderer,
  type ThemedDiffResult,
} from "@pierre/diffs";
import {
  WorkerPoolManager,
  type RenderDiffSuccessResponse,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerStats,
} from "@pierre/diffs/worker";

import { createAssertions } from "../browser-tests/assertions";

const before = 'export const workerNine: number = 40;\nexport const workerLabel = "before-nine";\n';
const after = 'export const workerNine: number = 41;\nexport const workerLabel = "worker-nine";\n';
const injectedError = "Stage 9A injected highlight response error";

// Expose the real renderer's public callbacks, without replacing its rendering behavior.
class ObservedFileDiff extends FileDiff {
  get highlighter() {
    return this.hunksRenderer;
  }
}

type Nodes = ThemedDiffResult["code"]["additionLines"];
function astText(nodes: Nodes): string {
  return nodes
    .map((node) =>
      node.type === "text" ? node.value : "children" in node ? astText(node.children) : "",
    )
    .join("");
}
// Pierre stores line nodes without their newline delimiters. Rejoin only at row boundaries.
function astSource(nodes: Nodes): string {
  return nodes.map((node) => astText([node])).join("\n") + "\n";
}
function styledTokens(nodes: Nodes): { text: string; style: string }[] {
  return nodes.flatMap((node) =>
    node.type !== "element"
      ? []
      : [
          ...(node.tagName === "span" && typeof node.properties.style === "string"
            ? [{ text: astText(node.children), style: node.properties.style }]
            : []),
          ...styledTokens(node.children),
        ],
  );
}

export async function testRealHighlightWorkerSuccessInBrowser() {
  return highlightFixture(false);
}

export async function testHighlightWorkerProtocolErrorInBrowser() {
  return highlightFixture(true);
}

async function highlightFixture(fail: boolean) {
  const { check, wait, result } = createAssertions(8000);
  const diff = parseDiffFromFile(
    { name: "worker-nine.ts", contents: before },
    { name: "worker-nine.ts", contents: after },
  );
  diff.cacheKey = `stage9a-${fail ? "error" : "success"}`;
  const requests: WorkerRequest[] = [];
  const responses: WorkerResponse[] = [];
  const responseStats: WorkerStats[] = [];
  const successes: Parameters<DiffHunksRenderer["onHighlightSuccess"]>[] = [];
  const errors: unknown[] = [];
  let held: RenderDiffSuccessResponse | undefined;
  let injecting = false;
  let injected = 0;
  let terminated = 0;
  let observing = 0;
  const workers: ObservedWorker[] = [];

  class ObservedWorker extends Worker {
    constructor() {
      // Same module entrypoint as DiffViewer, not a test worker or a fake pool.
      super(new URL("./highlight-worker.ts", import.meta.url), { type: "module" });
      this.addEventListener("message", this.observe);
      observing++;
    }
    private observe = (event: MessageEvent<WorkerResponse>) => {
      if (injecting) return;
      responses.push(event.data);
      responseStats.push(pool.getStats());
      if (fail && !held && event.data.type === "success" && event.data.requestType === "diff") {
        // Hold one actual worker response before the pool sees it. The test then
        // substitutes a valid error with that task's ID, not a Worker crash event.
        event.stopImmediatePropagation();
        held = event.data;
      }
    };
    override postMessage(
      message: WorkerRequest,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      requests.push(message);
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
    }
    deliverError() {
      if (!held) throw new Error("No matching worker response held");
      injecting = true;
      try {
        this.dispatchEvent(
          new MessageEvent<WorkerResponse>("message", {
            data: { type: "error", id: held.id, error: injectedError },
          }),
        );
        injected++;
      } finally {
        injecting = false;
      }
    }
    override terminate() {
      this.removeEventListener("message", this.observe);
      observing--;
      terminated++;
      super.terminate();
    }
  }

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:10px;overflow:auto;background:#111";
  document.body.append(host);
  const pool = new WorkerPoolManager(
    {
      poolSize: 1,
      workerFactory: () => {
        const worker = new ObservedWorker();
        workers.push(worker);
        return worker;
      },
    },
    { theme: "vesper" },
  );
  const view = new ObservedFileDiff({ theme: "vesper", diffStyle: "split" }, pool);
  const renderer = view.highlighter;
  const onSuccess = renderer.onHighlightSuccess.bind(renderer);
  const onError = renderer.onHighlightError.bind(renderer);
  renderer.onHighlightSuccess = (...args) => {
    successes.push(args);
    onSuccess(...args);
  };
  renderer.onHighlightError = (error) => {
    errors.push(error);
    onError(error);
  };
  const root = () => host.querySelector("diffs-container")?.shadowRoot;
  const additions = () => root()?.querySelector<HTMLElement>("code[data-additions]");
  const paintedSource = () =>
    [...(additions()?.querySelectorAll("[data-line]") ?? [])]
      .map((row) => row.textContent)
      .join("\n") + "\n";
  const colored = () =>
    [...(additions()?.querySelectorAll<HTMLElement>("span[style]") ?? [])].filter(
      (node) => node.style.color !== "",
    );
  const idle = () => {
    const stats = pool.getStats();
    return stats.activeTasks === 0 && stats.queuedTasks === 0 && stats.busyWorkers === 0;
  };
  try {
    let initializationError: unknown;
    void pool.initialize().catch((error) => {
      initializationError = error;
    });
    await wait(
      () => pool.isInitialized() || initializationError !== undefined,
      "Real highlight worker did not initialize",
    );
    check(initializationError === undefined, "Highlight worker initialization failed");
    check(
      workers.length === 1 && pool.getStats().totalWorkers === 1,
      "Fixture must own exactly one worker",
    );
    const init = requests.find((request) => request.type === "initialize");
    check(
      init &&
        responses.some(
          (response) =>
            response.type === "success" &&
            response.requestType === "initialize" &&
            response.id === init.id,
        ),
      "Initialization must have matching real protocol acknowledgement",
    );
    check(idle(), "Initialization must release its task");

    view.render({ fileDiff: diff, containerWrapper: host });
    check(
      paintedSource() === after,
      "Initial plain rows must contain this diff's exact new source",
    );
    check(colored().length === 0, "Plain fallback cannot count as highlighted output");
    await wait(
      () =>
        responses.some(
          (response) => response.type === "success" && response.requestType === "diff",
        ),
      "Real worker did not return a diff AST",
    );
    const request = requests.find((request) => request.type === "diff");
    const response = responses.find(
      (response) => response.type === "success" && response.requestType === "diff",
    );
    if (
      !request ||
      request.type !== "diff" ||
      !response ||
      response.type !== "success" ||
      response.requestType !== "diff"
    )
      throw new Error("Missing observed diff request/response");
    check(request.id === response.id, "Real worker response must match the submitted request ID");
    check(
      request.diff === diff && request.diff.name === "worker-nine.ts",
      "Renderer must submit the requested diff, not an unrelated highlight",
    );
    check(
      responseStats[responses.indexOf(response)].activeTasks === 1 &&
        responseStats[responses.indexOf(response)].busyWorkers === 1,
      "A real response must arrive while its pool task is active",
    );
    check(
      astSource(response.result.code.additionLines) === after &&
        astSource(response.result.code.deletionLines) === before,
      "Worker AST must match both sides of the known TypeScript diff",
    );
    const tokens = styledTokens(response.result.code.additionLines);
    const keyword = tokens.find((token) => token.text.trim() === "const");
    const literal = tokens.find((token) => token.text === "worker");
    check(
      keyword && literal && keyword.style !== literal.style,
      "Worker AST must contain differently styled TypeScript keyword and string tokens",
    );

    if (fail) {
      check(
        held === response && injected === 0,
        "Only the matching real diff response may be held for error substitution",
      );
      check(
        successes.length === 0 && errors.length === 0,
        "Held response must not notify the renderer early",
      );
      check(
        pool.getStats().activeTasks === 1 && pool.getStats().busyWorkers === 1,
        "Held response must retain its active task until error delivery",
      );
      workers[0].deliverError();
      check(
        injected === 1 &&
          errors.length === 1 &&
          errors[0] instanceof Error &&
          errors[0].message === injectedError,
        "Matching protocol error must reach the real renderer exactly once",
      );
      check(successes.length === 0, "Failed task must never report highlight success");
      check(
        pool.getDiffResultCache(diff) === undefined && pool.getStats().diffCacheSize === 0,
        "Failed task must not populate the highlight cache",
      );
      check(
        idle() && pool.isWorkingPool(),
        "Error response must release tasks without declaring the live worker dead",
      );
      check(
        paintedSource() === after && colored().length === 0,
        "Error must preserve usable plain source, not paint failed AST as highlighted",
      );
      const line = additions()?.querySelector<HTMLElement>("[data-line]");
      check(
        line && line.getBoundingClientRect().height > 0,
        "Retained plain source must remain painted",
      );
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
      check(
        successes.length === 0 &&
          errors.length === 1 &&
          idle() &&
          pool.getDiffResultCache(diff) === undefined &&
          paintedSource() === after &&
          colored().length === 0 &&
          requests.filter((request) => request.type === "diff").length === 1,
        "After error delivery, plain source must remain stable without false success, cache or automatic retry",
      );
      // A fresh request for the same diff proves failed task/key cleanup, not just counters.
      pool.highlightDiffAST(renderer, diff);
    }

    await wait(
      () => successes.length === 1 && idle() && colored().length > 0,
      "Successful real worker callback must repaint highlighted source and release its task",
    );
    const successful = successes[0];
    const finalResponse = responses
      .filter((response) => response.type === "success" && response.requestType === "diff")
      .at(-1);
    check(
      finalResponse?.type === "success" &&
        finalResponse.requestType === "diff" &&
        finalResponse.id === requests.filter((request) => request.type === "diff").at(-1)?.id &&
        successful[0] === diff &&
        successful[1] === finalResponse.result &&
        successful[2] === finalResponse.options,
      "Callback must receive the exact matching worker result/options for this diff",
    );
    check(
      pool.getDiffResultCache(diff)?.result === successful[1],
      "Only the successful worker AST may enter the cache",
    );
    check(paintedSource() === after, "Highlight repaint must preserve exact source text");
    const paintedKeyword = colored().find((node) => node.textContent?.trim() === "const");
    const paintedLiteral = colored().find((node) => node.textContent === "worker");
    check(
      paintedKeyword && paintedLiteral && paintedKeyword.style.color !== paintedLiteral.style.color,
      "DOM must paint differently colored keyword/string tokens, not merely plain rows",
    );
    check(errors.length === (fail ? 1 : 0), "Only the injected task may deliver an error");
    check(
      requests.filter((request) => request.type === "diff").length === (fail ? 2 : 1),
      "Request count must show one success or one failed task followed by one recovery",
    );
    check(
      new Set(requests.map((request) => request.id)).size === requests.length,
      "Initialization/highlight/recovery requests must use distinct IDs",
    );
    pool.cleanUpTasks(renderer);
    check(idle(), "Explicit renderer task cleanup must leave no queued/active work");
  } finally {
    renderer.onHighlightSuccess = onSuccess;
    renderer.onHighlightError = onError;
    view.cleanUp();
    pool.cleanUpTasks(renderer);
    pool.terminate();
    host.remove();
    check(
      terminated === workers.length && observing === 0,
      "Every owned worker must terminate and remove its observation listener",
    );
    check(
      pool.getStats().totalWorkers === 0 &&
        idle() &&
        pool.getStats().diffCacheSize === 0 &&
        pool.getStats().themeSubscribers === 0,
      "Termination must release workers, tasks, cache and renderer subscription",
    );
    check(!host.isConnected, "Fixture DOM must be removed");
  }
  return result();
}
