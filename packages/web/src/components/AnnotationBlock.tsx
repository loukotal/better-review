import type { Component } from "solid-js";

import { CriticalIcon } from "../icons/critical-icon";
import { InfoIcon } from "../icons/info-icon";
import { WarningIcon } from "../icons/warning-icon";
import type { Annotation, AnnotationSeverity } from "../utils/parseReviewTokens";

interface AnnotationBlockProps {
  annotation: Annotation;
  onNavigate: (file: string, line: number) => void;
  onAddAsComment?: (annotation: Annotation) => void;
}

const severityStyles: Record<
  AnnotationSeverity,
  { bg: string; border: string; icon: string; label: string }
> = {
  info: {
    bg: "bg-info/10",
    border: "border-info/30",
    icon: "text-info",
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
    return <InfoIcon size={12} />;
  }
  if (props.severity === "warning") {
    return <WarningIcon size={12} />;
  }
  // critical
  return <CriticalIcon size={12} />;
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
          <span class={`text-xs font-medium ${styles().icon}`}>{styles().label}</span>
          <button
            type="button"
            onClick={handleNavigate}
            class="text-xs font-mono text-text-muted hover:text-accent transition-colors"
          >
            {fileName()}:{props.annotation.line}
          </button>
        </div>
        {props.onAddAsComment && (
          <button
            type="button"
            onClick={handleAddAsComment}
            class="text-xs px-1.5 py-0.5 text-text-faint hover:text-accent border border-transparent hover:border-accent/30 transition-colors"
            title="Add as GitHub comment"
          >
            + Comment
          </button>
        )}
      </div>

      {/* Message */}
      <div class="text-sm text-text-muted leading-relaxed pl-5">{props.annotation.message}</div>
    </div>
  );
};
