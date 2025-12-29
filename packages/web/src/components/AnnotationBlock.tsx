import type { Component } from "solid-js";
import type { Annotation, AnnotationSeverity } from "../utils/parseReviewTokens";

interface AnnotationBlockProps {
  annotation: Annotation;
  onNavigate: (file: string, line: number) => void;
  onAddAsComment?: (annotation: Annotation) => void;
}

const severityStyles: Record<AnnotationSeverity, { bg: string; border: string; icon: string; label: string }> = {
  info: {
    bg: "bg-accent/10",
    border: "border-accent/30",
    icon: "text-accent",
    label: "Info",
  },
  warning: {
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    icon: "text-yellow-500",
    label: "Warning",
  },
  critical: {
    bg: "bg-error/10",
    border: "border-error/30",
    icon: "text-error",
    label: "Critical",
  },
};

function SeverityIcon(props: { severity: AnnotationSeverity }) {
  if (props.severity === "info") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm6.5-.25A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75zM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
      </svg>
    );
  }
  if (props.severity === "warning") {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5zm1 6a1 1 0 1 0-2 0 1 1 0 0 0 2 0z"/>
      </svg>
    );
  }
  // critical
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2.343 13.657A8 8 0 1 1 13.657 2.343 8 8 0 0 1 2.343 13.657zM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94 6.03 4.97z"/>
    </svg>
  );
}

/**
 * Displays an annotation with severity styling and action buttons
 */
export const AnnotationBlock: Component<AnnotationBlockProps> = (props) => {
  const styles = () => severityStyles[props.annotation.severity];
  
  const fileName = () => {
    const parts = props.annotation.file.split("/");
    return parts[parts.length - 1];
  };

  const handleNavigate = () => {
    props.onNavigate(props.annotation.file, props.annotation.line);
  };

  const handleAddAsComment = () => {
    props.onAddAsComment?.(props.annotation);
  };

  return (
    <div class={`my-2 p-2.5 border ${styles().bg} ${styles().border}`}>
      {/* Header */}
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-2">
          <span class={styles().icon}>
            <SeverityIcon severity={props.annotation.severity} />
          </span>
          <span class={`text-[10px] font-medium ${styles().icon}`}>
            {styles().label}
          </span>
          <button
            type="button"
            onClick={handleNavigate}
            class="text-[10px] font-mono text-text-muted hover:text-accent transition-colors"
          >
            {fileName()}:{props.annotation.line}
          </button>
        </div>
        {props.onAddAsComment && (
          <button
            type="button"
            onClick={handleAddAsComment}
            class="text-[9px] px-1.5 py-0.5 text-text-faint hover:text-accent border border-transparent hover:border-accent/30 transition-colors"
            title="Add as GitHub comment"
          >
            + Comment
          </button>
        )}
      </div>
      
      {/* Message */}
      <div class="text-[11px] text-text-muted leading-relaxed pl-5">
        {props.annotation.message}
      </div>
    </div>
  );
};
