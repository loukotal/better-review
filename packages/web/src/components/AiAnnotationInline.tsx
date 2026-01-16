import { type Component, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";

import type { Annotation, AnnotationSeverity } from "../utils/parseReviewTokens";

export interface AiAnnotationInlineProps {
  annotation: Annotation;
  onAddAsComment: (annotation: Annotation, prefillBody: string) => void;
  onDismiss?: (annotationId: string) => void;
}

const severityConfig: Record<
  AnnotationSeverity,
  {
    borderColor: string;
    iconColor: string;
    label: string;
  }
> = {
  info: {
    borderColor: "border-l-info/60",
    iconColor: "text-info",
    label: "Info",
  },
  warning: {
    borderColor: "border-l-yellow-500/60",
    iconColor: "text-yellow-500",
    label: "Warning",
  },
  critical: {
    borderColor: "border-l-error/60",
    iconColor: "text-error",
    label: "Critical",
  },
};

function SparklesIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.53 1.282a.5.5 0 0 1 .94 0l.478 1.306a7.5 7.5 0 0 0 4.464 4.464l1.305.478a.5.5 0 0 1 0 .94l-1.305.478a7.5 7.5 0 0 0-4.464 4.464l-.478 1.305a.5.5 0 0 1-.94 0l-.478-1.305a7.5 7.5 0 0 0-4.464-4.464L1.282 8.47a.5.5 0 0 1 0-.94l1.306-.478a7.5 7.5 0 0 0 4.464-4.464L7.53 1.282Z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  );
}

function DismissIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function SeverityIcon(props: { severity: AnnotationSeverity }) {
  if (props.severity === "info") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm6.5-.25A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75zM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
      </svg>
    );
  }
  if (props.severity === "warning") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5zm1 6a1 1 0 1 0-2 0 1 1 0 0 0 2 0z" />
      </svg>
    );
  }
  // critical
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2.343 13.657A8 8 0 1 1 13.657 2.343 8 8 0 0 1 2.343 13.657zM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94 6.03 4.97z" />
    </svg>
  );
}

/**
 * Inline AI annotation displayed in the diff view.
 * Visually distinct from GitHub comments with a colored left border and AI badge.
 */
export const AiAnnotationInline: Component<AiAnnotationInlineProps> = (props) => {
  const [isHovered, setIsHovered] = createSignal(false);
  const config = () => severityConfig[props.annotation.severity];

  const handleAddAsComment = () => {
    // Prefill the comment with a formatted version of the AI annotation
    const prefillBody = `**${config().label}:** ${props.annotation.message}`;
    props.onAddAsComment(props.annotation, prefillBody);
  };

  const handleDismiss = () => {
    props.onDismiss?.(props.annotation.id);
  };

  return (
    <div
      class={`
        relative border-l-2 ${config().borderColor}
        pl-3 pr-2 py-2 font-mono
        transition-colors duration-150
        ${isHovered() ? "bg-bg-surface/20" : ""}
      `}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header row */}
      <div class="flex items-center gap-2 mb-1">
        {/* Severity indicator */}
        <span class={`inline-flex items-center gap-1 ${config().iconColor}`}>
          <SeverityIcon severity={props.annotation.severity} />
          <span class="text-xs">{config().label}</span>
        </span>

        {/* Line number */}
        <span class="text-xs text-text-faint font-mono">L{props.annotation.line}</span>
        <span class="inline-flex items-center gap-1 text-accent/70 text-xs">
          <SparklesIcon />
          <span>AI</span>
        </span>

        {/* Actions - fade in on hover */}
        <div
          class={`flex items-center gap-1 ml-auto transition-opacity duration-150 ${isHovered() ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <button
            type="button"
            onClick={handleAddAsComment}
            class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 
                   text-text-faint hover:text-accent
                   transition-colors duration-150"
            title="Convert to GitHub comment"
          >
            <CommentIcon />
            <span>Comment</span>
          </button>
          <Show when={props.onDismiss}>
            <button
              type="button"
              onClick={handleDismiss}
              class="inline-flex items-center justify-center w-5 h-5 
                     text-text-faint hover:text-error
                     transition-colors duration-150"
              title="Dismiss annotation"
            >
              <DismissIcon />
            </button>
          </Show>
        </div>
      </div>

      {/* Message */}
      <p class="text-sm text-text-muted leading-relaxed m-0 pl-0">{props.annotation.message}</p>
    </div>
  );
};

/**
 * Render AiAnnotationInline into a DOM element. Returns dispose function.
 */
export function renderAiAnnotation(
  container: HTMLElement,
  props: AiAnnotationInlineProps,
): () => void {
  return render(() => <AiAnnotationInline {...props} />, container);
}
