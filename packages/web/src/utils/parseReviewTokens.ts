/**
 * Token parser for AI review responses.
 *
 * Parses special tokens:
 * - <<REVIEW_ORDER>>["file1", "file2"]<</REVIEW_ORDER>>
 * - <<ANNOTATION file="path" line="42" severity="warning">>message<</ANNOTATION>>
 * - [[file:path/to/file.ts]] or [[file:path/to/file.ts:42]]
 */

export type AnnotationSeverity = "info" | "warning" | "critical" | "error";

export interface Annotation {
  id: string;
  file: string;
  line: number;
  severity: AnnotationSeverity;
  message: string;
  /** Trusted transcript metadata, never inferred from the currently displayed diff. */
  origin?: { sessionId: string; revision?: string };
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "file-ref"; file: string; line?: number }
  | { type: "annotation"; annotation: Annotation }
  | { type: "review-order"; files: string[] };

export interface ParsedMessage {
  segments: MessageSegment[];
  reviewOrder: string[] | null;
  annotations: Annotation[];
}

// Regex patterns
const REVIEW_ORDER_PATTERN = /<<REVIEW_ORDER>>([\s\S]*?)<<\/REVIEW_ORDER>>/g;
const ANNOTATION_PATTERN =
  /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|note|warning|critical|error)">>([^]*?)<<\/ANNOTATION>>/g;
// Match file refs, optionally wrapped in ** (bold markdown)
const FILE_REF_PATTERN = /\*{0,2}\[\[file:([^\]:\s]+)(?::(\d+))?\]\]\*{0,2}/g;

function normalizeReviewOrderJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Generate a stable annotation ID based on content.
 * This ensures the same annotation always gets the same ID for proper deduplication.
 */
function generateAnnotationId(
  file: string,
  line: number,
  severity: string,
  message: string,
): string {
  const content = `${file}:${line}:${severity}:${message}`;
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (hash << 5) - hash + content.charCodeAt(i);
    hash = hash & hash;
  }
  return `annotation-${Math.abs(hash).toString(36)}`;
}

function normalizeSeverity(severity: string): AnnotationSeverity {
  return severity === "note" ? "info" : (severity as AnnotationSeverity);
}

function parseOrder(raw: string): string[] | null {
  try {
    const files = JSON.parse(normalizeReviewOrderJson(raw));
    return Array.isArray(files) ? files : null;
  } catch {
    return null;
  }
}

function rewriteAnnotations(
  content: string,
  rewrite: (annotation: Annotation, originalSeverity: string) => string,
): string {
  return content.replace(ANNOTATION_PATTERN, (_raw, file, lineStr, severity, message) => {
    const lineMatch = lineStr.match(/^(\d+)/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
    const trimmedMessage = message.trim();
    const normalizedSeverity = normalizeSeverity(severity);
    return rewrite(
      {
        id: generateAnnotationId(file, line, normalizedSeverity, trimmedMessage),
        file,
        line,
        severity: normalizedSeverity,
        message: trimmedMessage,
      },
      severity,
    );
  });
}

/** One grammar and normalization pipeline; callers choose rendering or export policy.
 * Order blocks run first, then annotations, then references in the resulting text.
 * Original severity and line digits are presentation evidence, not annotation identity.
 */
export function rewriteReviewTokens(
  content: string,
  rewrite: {
    reviewOrder: (files: string[] | null, raw: string) => string;
    annotation: (annotation: Annotation, originalSeverity: string) => string;
    fileRef: (file: string, originalLine: string | undefined) => string;
  },
): string {
  const withoutOrders = content.replace(REVIEW_ORDER_PATTERN, (raw, json) =>
    rewrite.reviewOrder(parseOrder(json), raw),
  );
  return rewriteAnnotations(withoutOrders, rewrite.annotation).replace(
    FILE_REF_PATTERN,
    (_raw, file, line) => rewrite.fileRef(file, line),
  );
}

export function parseReviewTokens(content: string): ParsedMessage {
  const annotations: Annotation[] = [];
  let reviewOrder: string[] | null = null;
  const segments: MessageSegment[] = [];
  const placeholders: Map<string, MessageSegment> = new Map();
  const orderSources = new Map<string, string>();
  // Reserve a namespace absent from input. Keys are local positions, never IDs.
  let prefix = "__REVIEW_TOKEN_";
  while (content.includes(prefix)) prefix = `_${prefix}`;
  function hold(segment: MessageSegment) {
    const key = `${prefix}${placeholders.size}__`;
    placeholders.set(key, segment);
    return key;
  }
  const processed = rewriteReviewTokens(content, {
    reviewOrder(files, raw) {
      if (!files) return raw;
      reviewOrder = files;
      const key = hold({ type: "review-order", files });
      orderSources.set(key, raw);
      return key;
    },
    annotation(annotation) {
      // Internal placeholders must never become annotation text or hash input.
      const message = annotation.message.replace(
        new RegExp(`${prefix}\\d+__`, "g"),
        (key) => orderSources.get(key) ?? key,
      );
      const original =
        message === annotation.message
          ? annotation
          : {
              ...annotation,
              message,
              id: generateAnnotationId(
                annotation.file,
                annotation.line,
                annotation.severity,
                message,
              ),
            };
      annotations.push(original);
      return hold({ type: "annotation", annotation: original });
    },
    fileRef(file, line) {
      return hold({ type: "file-ref", file, line: line ? parseInt(line, 10) : undefined });
    },
  });
  for (const part of processed.split(new RegExp(`(${prefix}\\d+__)`))) {
    if (!part) continue;
    segments.push(placeholders.get(part) ?? { type: "text", content: part });
  }
  return { segments, reviewOrder, annotations };
}

/**
 * Check if a message contains any special review tokens
 */
export function hasReviewTokens(content: string): boolean {
  return (
    content.search(REVIEW_ORDER_PATTERN) >= 0 ||
    content.search(ANNOTATION_PATTERN) >= 0 ||
    content.search(FILE_REF_PATTERN) >= 0
  );
}

/**
 * Extract just the review order from content (for quick access)
 */
export function extractReviewOrder(content: string): string[] | null {
  const first = content.matchAll(REVIEW_ORDER_PATTERN).next().value;
  return first ? parseOrder(first[1]) : null;
}

/**
 * Extract all annotations from content
 */
export function extractAnnotations(content: string): Annotation[] {
  const annotations: Annotation[] = [];
  rewriteAnnotations(content, (annotation) => {
    annotations.push(annotation);
    return "";
  });
  return annotations;
}
