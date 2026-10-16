import type { FileDiffMetadata } from "@pierre/diffs";
import { createSignal } from "solid-js";

import { normalizeSourcePath, type ResolvedSource } from "@better-review/shared";

import type { SelectionEditorDraft } from "../components/AnchoredSelectionEditor";
import type { InlineFindingDraft } from "../components/InlineFindingComment";
import type { Annotation } from "../utils/parseReviewTokens";
import type { SourceTarget } from "./annotation-navigation";
import {
  createSelectionDraft,
  createSelectionSender,
  selectionRevision,
  validateSelection,
  type SelectedSource,
  type SourceSelection,
} from "./ask-ai-selection";
import {
  findingCommentKey,
  prepareFindingComment,
  type FindingCommentRequest,
} from "./finding-comment";
import { createSelectionQuestionState, createCachedCommentDraft } from "./interaction-drafts";
import type { ReviewClient } from "./review-client";
import type { SelectionBubbleAnchor } from "./selection-bubble";

/** Lookup destinations never replace the original reference, including captured source. */
export interface ResolvedDestination {
  readonly original: SourceTarget;
  readonly result: ResolvedSource;
}
type FoundSource = Extract<ResolvedSource, { status: "found" }>;
export interface SourceWindow {
  startLine: number;
  endLine: number;
}
type ResolveSource = (
  target: SourceTarget,
  range: SourceWindow,
  signal: AbortSignal,
) => Promise<ResolvedSource>;
const SOURCE_WINDOW_LINES = 200;

/** Also used by standalone source views; late lookups cannot publish or navigate. */
export function createSourceNavigation(scope: () => string, resolve: ResolveSource) {
  const [target, setTarget] = createSignal<SourceTarget | null>(null);
  const [destination, setDestination] = createSignal<ResolvedDestination>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<Error>();
  const [range, setRange] = createSignal<SourceWindow>();
  let version = 0;
  let controller: AbortController | undefined;
  let resolvedFocus: ((source: FoundSource) => boolean) | undefined;
  const close = () => {
    version++;
    controller?.abort();
    setTarget(null);
    setDestination(undefined);
    setLoading(false);
    setError(undefined);
  };
  async function openSource(
    original: SourceTarget,
    focus?: (source: FoundSource) => boolean,
    window?: SourceWindow,
  ) {
    const request = ++version;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    resolvedFocus = focus;
    const startLine = Math.max(1, (original.line ?? 1) - SOURCE_WINDOW_LINES / 2);
    const requestedRange = window ?? { startLine, endLine: startLine + SOURCE_WINDOW_LINES - 1 };
    const requestScope = scope();
    setRange(requestedRange);
    setTarget(original);
    setDestination(undefined);
    setError(undefined);
    setLoading(true);
    const current = () => request === version && scope() === requestScope;
    try {
      const value = await resolve(original, requestedRange, signal);
      if (!current()) return;
      const result =
        value.status === "found"
          ? {
              ...value,
              approximate: value.approximate || !!original.lookup?.approximate,
              notice: [original.lookup?.notice, value.notice].filter(Boolean).join(" ") || null,
            }
          : value;
      setDestination({ original, result });
      if (result.status === "found" && !result.approximate && !original.notice && focus?.(result))
        close();
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause : new Error("Source lookup failed"));
    } finally {
      if (current()) setLoading(false);
    }
  }
  const page = (direction: "earlier" | "later") => {
    const original = target();
    const result = destination()?.result;
    if (!original || result?.status !== "found" || loading()) return;
    const first = result.contentStartLine ?? 1;
    const last = result.contentEndLine ?? result.content.split(/\r?\n/).length;
    const total = result.totalLines ?? last;
    if (direction === "earlier" && first > 1)
      return openSource(original, undefined, {
        startLine: Math.max(1, first - SOURCE_WINDOW_LINES),
        endLine: first - 1,
      });
    if (direction === "later" && last < total)
      return openSource(original, undefined, {
        startLine: last + 1,
        endLine: Math.min(total, last + SOURCE_WINDOW_LINES),
      });
  };
  const presentation = () => {
    const original = target();
    if (!original) return;
    const result = destination()?.result;
    const found = result?.status === "found" ? result : undefined;
    const captured =
      original.captured && (!found || found.approximate) ? original.captured : undefined;
    if (!captured && !found) return;
    const text = captured?.text ?? found!.content;
    const startLine = captured?.startLine ?? found?.contentStartLine ?? 1;
    const suppliedEnd = captured?.endLine ?? found?.contentEndLine;
    const split = text.split(/\r?\n/);
    // Ranged source preserves its last line terminator. It is not another row.
    // Use absolute bounds, not trim/filter: empty source and real blank lines count.
    const lines =
      suppliedEnd !== undefined
        ? split.slice(0, suppliedEnd - startLine + 1)
        : text.endsWith("\n")
          ? split.slice(0, -1)
          : split;
    return {
      text,
      lines,
      startLine,
      endLine: suppliedEnd ?? startLine + lines.length - 1,
      path: captured ? original.path : found!.path,
      ref: captured ? original.ref : found!.ref,
      side: captured ? (original.side ?? "RIGHT") : found!.side,
      captured: !!captured,
    };
  };
  return {
    target,
    destination,
    loading,
    error,
    range,
    openSource,
    close,
    page,
    presentation,
    selectSource(startLine: number, endLine: number, text: string): SelectedSource | undefined {
      const view = presentation();
      if (!view?.ref || loading()) return;
      validateSelection(text);
      if (
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < view.startLine ||
        endLine > view.endLine ||
        endLine < startLine
      )
        throw new Error("Select a valid range within the displayed source window.");
      return { file: view.path, side: view.side, revision: view.ref, startLine, endLine, text };
    },
    chooseTarget(path: string): SourceTarget | undefined {
      const original = target();
      const result = destination()?.result;
      if (!original || result?.status !== "ambiguous" || !result.candidates.includes(path)) return;
      return {
        ...original,
        lookup: {
          path,
          ref: result.ref,
          side: result.side,
          approximate: result.approximate || !!original.lookup?.approximate,
          notice: result.approximate
            ? `${result.notice} Chosen path: ${path}; correspondence remains approximate.`
            : (original.lookup?.notice ?? null),
        },
      };
    },
    retry: () => {
      const original = target();
      if (original) return openSource(original, resolvedFocus, range());
    },
  };
}

export interface ReviewInteractionContext {
  prUrl: string;
  loadedPrUrl: string | null;
  scope: string;
  headSha?: string | null;
  comparisonBaseSha?: string | null;
  commitSha?: string | null;
  commitScope: boolean;
  loading: boolean;
  files: FileDiffMetadata[];
}

interface QuestionDestination {
  target: string;
  isCurrent: () => boolean;
  createSession: () => Promise<string>;
  client: (id: string) => Pick<ReviewClient, "history" | "send">;
}

/** Standalone chat panels use the same delivery implementation as the review page. */
export function createQuestionDelivery(context: () => { scope: string; ready: boolean }) {
  const sender = createSelectionSender();
  return {
    askAbout(selection: SourceSelection, body: string, destination: QuestionDestination) {
      const scope = context().scope;
      return sender.send({
        ...destination,
        draftId: selection.draftId,
        body,
        isCurrent: () =>
          context().ready &&
          context().scope === scope &&
          selection.scope === scope &&
          destination.isCurrent(),
      });
    },
  };
}

export function createReviewInteractions(
  context: () => ReviewInteractionContext,
  navigation: { resolve: ResolveSource; focus: (source: FoundSource) => boolean },
) {
  const source = createSourceNavigation(() => context().scope, navigation.resolve);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [findingComment, setFindingComment] = createSignal<FindingCommentRequest | null>(null);
  const [inlineFinding, setInlineFinding] = createSignal<InlineFindingDraft | null>(null);
  const drafts = new Map<string, InlineFindingDraft>();
  const [question, setQuestion] = createSignal<SelectionEditorDraft | null>(null);
  const [selectionClearToken, setSelectionClearToken] = createSignal(0);
  const ready = () => {
    const value = context();
    return !!value.loadedPrUrl && value.prUrl === value.loadedPrUrl && !value.loading;
  };
  const delivery = createQuestionDelivery(() => ({ scope: context().scope, ready: ready() }));
  const focusCurrent = (resolved: FoundSource) => {
    const value = context();
    const revision = value.commitScope ? value.commitSha : value.headSha;
    return (
      ready() &&
      !resolved.approximate &&
      resolved.side === "RIGHT" &&
      resolved.ref === revision &&
      navigation.focus(resolved)
    );
  };
  const currentComment = (request: FindingCommentRequest) => {
    const value = context();
    return (
      ready() &&
      !value.commitScope &&
      request.scope === value.scope &&
      request.prUrl === value.loadedPrUrl &&
      request.expectedHeadSha === value.headSha
    );
  };
  const finishComment = (entry: InlineFindingDraft) => {
    drafts.delete(findingCommentKey(entry.request));
    if (inlineFinding() === entry) setInlineFinding(null);
  };
  return {
    source,
    notice,
    findingComment,
    inlineFinding,
    question,
    selectionClearToken,
    dismissNotice: () => setNotice(null),
    currentComment,
    finishComment,
    assertCurrentComment(request: FindingCommentRequest) {
      if (!currentComment(request))
        throw new Error("PR or revision changed. This draft was not submitted.");
    },
    openSource(target: SourceTarget, knownCurrent = false) {
      const path = normalizeSourcePath(target.path);
      const value = context();
      // Only exact repository paths with independently known provenance may skip lookup.
      if (
        knownCurrent &&
        ready() &&
        target.ref &&
        path &&
        value.files.some((file) => file.name === path) &&
        !target.lookup?.approximate &&
        focusCurrent({
          status: "found",
          path,
          ref: target.ref,
          line: target.line ?? 1,
          side: target.side ?? "RIGHT",
          content: "",
          approximate: false,
          notice: null,
        })
      ) {
        source.close();
        return Promise.resolve();
      }
      return source.openSource(target, focusCurrent);
    },
    prepareComment(annotation: Annotation, sessionId: string, reviewedRef?: string | null) {
      try {
        if (!ready())
          throw new Error(
            "Wait for the current PR revision to finish loading; existing drafts were preserved.",
          );
        const value = context();
        const prepared = prepareFindingComment(annotation, {
          prUrl: value.loadedPrUrl!,
          sessionId,
          scope: value.scope,
          reviewedRef,
          displayedHeadSha: value.headSha,
          files: value.files,
          commitScope: value.commitScope,
        });
        setNotice(null);
        if (prepared.inPatch) {
          setInlineFinding(null);
          setFindingComment(prepared.request);
          focusCurrent({
            status: "found",
            path: prepared.request.filePath,
            ref: prepared.request.expectedHeadSha,
            line: prepared.request.line,
            side: "RIGHT",
            content: "",
            approximate: false,
            notice: null,
          });
        } else {
          const key = findingCommentKey(prepared.request);
          const entry = {
            request: prepared.request,
            draft: drafts.get(key)?.draft ?? createCachedCommentDraft(prepared.request.body),
          };
          drafts.set(key, entry);
          setInlineFinding(entry);
        }
        return prepared;
      } catch (cause) {
        setNotice(
          cause instanceof Error
            ? cause.message
            : "Could not prepare this finding. Existing drafts were preserved.",
        );
      }
    },
    selectSource(selection: SelectedSource, anchor: SelectionBubbleAnchor, revision?: string) {
      if (!ready() || question()) return;
      const value = context();
      const sourceRevision =
        revision ??
        selection.revision ??
        selectionRevision(
          selection.side,
          { headSha: value.headSha, comparisonBaseSha: value.comparisonBaseSha },
          value.commitSha,
        );
      setQuestion({
        selection: createSelectionDraft(selection, sourceRevision, value.scope),
        anchor: { ...anchor, fallbackRect: anchor.rect(false) ?? undefined },
        state: createSelectionQuestionState(),
      });
    },
    dismissSelection() {
      setQuestion(null);
      setSelectionClearToken((value) => value + 1);
    },
    askAbout: delivery.askAbout,
  };
}

export type ReviewInteractions = ReturnType<typeof createReviewInteractions>;
export type SourceNavigation = ReturnType<typeof createSourceNavigation>;
