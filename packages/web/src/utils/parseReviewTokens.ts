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

export interface FileRef {
  file: string;
  line?: number;
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

// Regex patterns - note: closing tags use << >> not </ >>
const REVIEW_ORDER_PATTERN = /<<REVIEW_ORDER>>([\s\S]*?)<<\/REVIEW_ORDER>>/g;
const ANNOTATION_PATTERN =
  /<<ANNOTATION\s+file="([^"]+)"\s+line="([^"]+)"\s+severity="(info|warning|critical)">>([^]*?)<<\/ANNOTATION>>/g;
const FILE_REF_PATTERN = /\[\[file:([^\]:\s]+)(?::(\d+))?\]\]/g;
// Pattern to clean up hallucinated placeholder-like strings from the AI
const HALLUCINATED_PLACEHOLDER_PATTERN = /#{1,3}\s*__FILE_REF_[^_\s]+_[^_\s]+__\s*\n?/g;

let annotationIdCounter = 0;

function generateAnnotationId(): string {
  return `annotation-${Date.now()}-${annotationIdCounter++}`;
}

export function parseReviewTokens(content: string): ParsedMessage {
  const annotations: Annotation[] = [];
  let reviewOrder: string[] | null = null;
  const segments: MessageSegment[] = [];

  // First pass: Extract review order and annotations, replace with placeholders
  let processedContent = content;
  const placeholders: Map<string, MessageSegment> = new Map();

  // Clean up any hallucinated placeholder-like strings from the AI
  processedContent = processedContent.replace(HALLUCINATED_PLACEHOLDER_PATTERN, "");

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
    (match, file, lineStr, severity, message) => {
      // Handle line ranges like "15-16" by taking the first number
      const lineMatch = lineStr.match(/^(\d+)/);
      const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

      const annotation: Annotation = {
        id: generateAnnotationId(),
        file,
        line,
        severity: severity as AnnotationSeverity,
        message: message.trim(),
      };
      annotations.push(annotation);
      const placeholder = `__ANNOTATION_${annotation.id}__`;
      placeholders.set(placeholder, { type: "annotation", annotation });
      return placeholder;
    },
  );

  // Extract file references
  processedContent = processedContent.replace(FILE_REF_PATTERN, (match, file, line) => {
    const placeholder = `__FILE_REF_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    placeholders.set(placeholder, {
      type: "file-ref",
      file,
      line: line ? parseInt(line, 10) : undefined,
    });
    return placeholder;
  });

  // Build segments by splitting on placeholders
  const placeholderPattern = /__(?:REVIEW_ORDER|ANNOTATION|FILE_REF)_[^_]+__/g;
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
    // Handle line ranges like "15-16" by taking the first number
    const lineMatch = match[2].match(/^(\d+)/);
    const line = lineMatch ? parseInt(lineMatch[1], 10) : 1;

    annotations.push({
      id: generateAnnotationId(),
      file: match[1],
      line,
      severity: match[3] as AnnotationSeverity,
      message: match[4].trim(),
    });
  }

  return annotations;
}
