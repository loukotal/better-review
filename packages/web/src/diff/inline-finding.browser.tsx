import { parsePatchFiles } from "@pierre/diffs";
/** Actual DiffViewer annotation body/action → validated request → editor → local submission spy. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { DiffViewer, DEFAULT_DIFF_SETTINGS, type DiffCommentDraft } from "../DiffViewer";
import { prepareFindingComment, type FindingCommentRequest } from "../lib/finding-comment";
import type { Annotation } from "../utils/parseReviewTokens";

export async function testInlineFindingProvenanceInBrowser() {
  const head = "a".repeat(40),
    old = "b".repeat(40);
  const rawDiff =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n";
  const files = parsePatchFiles(rawDiff).flatMap((patch) => patch.files);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:10px;overflow:auto;z-index:9999;background:#111";
  document.body.append(host);
  const [annotations, setAnnotations] = createSignal<Annotation[]>([]);
  const [request, setRequest] = createSignal<FindingCommentRequest | null>(null);
  const [commit, setCommit] = createSignal(false);
  const posts: DiffCommentDraft[] = [],
    received: Annotation[] = [];
  let rejection = "",
    passed = 0;
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  };
  const check = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message);
    passed++;
  };
  const dispose = render(
    () => (
      <DiffViewer
        rawDiff={rawDiff}
        comments={[]}
        aiAnnotations={annotations()}
        settings={DEFAULT_DIFF_SETTINGS}
        commentHeadSha={head}
        findingComment={request()}
        commitScope={commit()}
        selectionScope={commit() ? "commit-C" : "pr-H"}
        prUrl="https://github.com/o/r/pull/1"
        onCreateFindingComment={(annotation: Annotation) => {
          received.push(annotation);
          try {
            const result = prepareFindingComment(annotation, {
              prUrl: "https://github.com/o/r/pull/1",
              sessionId: annotation.origin?.sessionId ?? "",
              reviewedRef: annotation.origin?.revision,
              displayedHeadSha: head,
              commitScope: commit(),
              scope: commit() ? "commit-C" : "pr-H",
              files,
            });
            setRequest(result.request);
          } catch (error) {
            rejection = (error as Error).message;
          }
        }}
        onAddComment={async (draft) => {
          posts.push(draft);
        }}
        onReplyToComment={async () => {}}
        onEditComment={async () => {}}
        onDeleteComment={async () => {}}
      />
    ),
    host,
  );
  try {
    for (const scenario of ["historical", "unknown", "commit", "current"] as const) {
      setCommit(scenario === "commit");
      setRequest(null);
      rejection = "";
      const annotation: Annotation = {
        id: `inline-${scenario}`,
        file: "src/a.ts",
        line: 2,
        severity: "warning",
        message: `finding-${scenario}`,
        ...(scenario !== "unknown"
          ? { origin: { sessionId: "saved-origin", revision: scenario === "current" ? head : old } }
          : {}),
      };
      setAnnotations([annotation]);
      await settle();
      const card = host.querySelector<HTMLElement>('[aria-label="Prepare comment for src/a.ts:2"]');
      check(!!card, `${scenario}: actual inline annotation missing`);
      for (const action of ["body", "button"]) {
        if (action === "body") card!.click();
        else
          card!
            .querySelector<HTMLButtonElement>('[title="Create PR comment from this suggestion"]')!
            .click();
        await settle();
        check(
          received.at(-1)?.origin?.revision === annotation.origin?.revision &&
            received.at(-1)?.id === annotation.id,
          `${scenario}: inline action bypassed validated callback or lost origin`,
        );
        if (scenario !== "current") {
          check(
            !host.querySelector('form[aria-label="New inline comment"]') &&
              rejection &&
              !posts.length,
            `${scenario}: unsafe source created a current-head draft`,
          );
        }
      }
      if (scenario === "current") {
        const form = host.querySelector<HTMLFormElement>('form[aria-label="New inline comment"]');
        check(
          !!form && form.querySelector("textarea")?.value.includes("src/a.ts:2"),
          "validated current inline action must prefill full file reference",
        );
        form!.requestSubmit();
        await settle();
        check(
          posts.length === 1 &&
            posts[0].expectedHeadSha === head &&
            posts[0].filePath === "src/a.ts" &&
            posts[0].line === 2 &&
            posts[0].side === "RIGHT",
          "submission spy lost validated source provenance/coordinates",
        );
      }
    }
    return { passed, interceptedSubmissions: posts.length, networkPosts: 0, modelCalls: 0 };
  } finally {
    dispose();
    host.remove();
  }
}
