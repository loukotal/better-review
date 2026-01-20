/**
 * Token parser for AI review responses.
 *
 * Parses special tokens:
 * - <<REVIEW_ORDER>>["file1", "file2"]<</REVIEW_ORDER>>
 * - <<ANNOTATION file="path" line="42" severity="warning">>message<</ANNOTATION>>
 * - [[file:path/to/file.ts]] or [[file:path/to/file.ts:42]]
 */

export type AnnotationSeverity = "info" | "warning" | "critical";

export interface Annotation {
  id: string;
  file: string;
  line: number;
  severity: AnnotationSeverity;
  message: string;
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
// Match REVIEW_ORDER with optional surrounding code block (```\n...\n```)
const REVIEW_ORDER_PATTERN = /(?:```\n?)?<<REVIEW_ORDER>>([\s\S]*?)<<\/REVIEW_ORDER>>(?:\n?```)?/g;
const ANNOTATION_PATTERN =
  /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|warning|critical)">>([^]*?)<<\/ANNOTATION>>/g;
// Match file refs, optionally wrapped in ** (bold markdown)
const FILE_REF_PATTERN = /\*{0,2}\[\[file:([^\]:\s]+)(?::(\d+))?\]\]\*{0,2}/g;

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

export function parseReviewTokens(content: string): ParsedMessage {
  const annotations: Annotation[] = [];
  let reviewOrder: string[] | null = null;
  const segments: MessageSegment[] = [];

  let processedContent = content;
  const placeholders: Map<string, MessageSegment> = new Map();

  // Extract review order
  processedContent = processedContent.replace(REVIEW_ORDER_PATTERN, (match, jsonContent) => {
    try {
      const files = JSON.parse(jsonContent.trim());
      if (Array.isArray(files)) {
        reviewOrder = files;
        const placeholder = `__REVIEW_ORDER_${Date.now()}__`;
        placeholders.set(placeholder, { type: "review-order", files });
        return placeholder;
      }
    } catch {
      // If JSON parsing fails, keep original
    }
    return match;
  });

  // Extract annotations
  processedContent = processedContent.replace(
    ANNOTATION_PATTERN,
    (_match, file, lineStr, severity, message) => {
      // Handle line ranges like "15-16" by taking the first number
      const lineMatch = lineStr.match(/^(\d+)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

      const trimmedMessage = message.trim();
      const annotation: Annotation = {
        id: generateAnnotationId(file, line, severity, trimmedMessage),
        file,
        line,
        severity: severity as AnnotationSeverity,
        message: trimmedMessage,
      };
      annotations.push(annotation);
      const placeholder = `__ANNOTATION_${annotation.id}__`;
      placeholders.set(placeholder, { type: "annotation", annotation });
      return placeholder;
    },
  );

  // Extract file references
  processedContent = processedContent.replace(FILE_REF_PATTERN, (_match, file, line) => {
    const placeholder = `__FILE_REF_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    placeholders.set(placeholder, {
      type: "file-ref",
      file,
      line: line ? parseInt(line, 10) : undefined,
    });
    return placeholder;
  });

  // Build segments by splitting on placeholders
  const placeholderPattern = /__(?:REVIEW_ORDER|ANNOTATION|FILE_REF)_[^_]+(?:_[^_]+)?__/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholderPattern.exec(processedContent)) !== null) {
    // Add text before placeholder
    if (match.index > lastIndex) {
      const text = processedContent.slice(lastIndex, match.index);
      if (text) {
        segments.push({ type: "text", content: text });
      }
    }

    // Add placeholder content
    const segment = placeholders.get(match[0]);
    if (segment) {
      segments.push(segment);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < processedContent.length) {
    const text = processedContent.slice(lastIndex);
    if (text) {
      segments.push({ type: "text", content: text });
    }
  }

  // If no segments were created, treat the whole content as text
  if (segments.length === 0 && content) {
    segments.push({ type: "text", content });
  }

  return { segments, reviewOrder, annotations };
}

/**
 * Check if a message contains any special review tokens
 */
export function hasReviewTokens(content: string): boolean {
  return (
    REVIEW_ORDER_PATTERN.test(content) ||
    ANNOTATION_PATTERN.test(content) ||
    FILE_REF_PATTERN.test(content)
  );
}

/**
 * Extract just the review order from content (for quick access)
 */
export function extractReviewOrder(content: string): string[] | null {
  const match = content.match(/<<REVIEW_ORDER>>([\s\S]*?)<<\/REVIEW_ORDER>>/);
  if (match) {
    try {
      const files = JSON.parse(match[1].trim());
      if (Array.isArray(files)) {
        return files;
      }
    } catch {
      // Ignore parse errors
    }
  }
  return null;
}

/**
 * Extract all annotations from content
 */
export function extractAnnotations(content: string): Annotation[] {
  const annotations: Annotation[] = [];
  const pattern =
    /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|warning|critical)">>([^]*?)<<\/ANNOTATION>>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const lineMatch = match[2].match(/^(\d+)/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;
    const file = match[1];
    const severity = match[3] as AnnotationSeverity;
    const message = match[4].trim();

    annotations.push({
      id: generateAnnotationId(file, line, severity, message),
      file,
      line,
      severity,
      message,
    });
  }

  return annotations;
}
