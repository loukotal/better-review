import { type Component, For, createMemo, createSignal } from "solid-js";

import { IconButton } from "../design-system";
import { CheckIcon } from "../icons/check-icon";
import { CopyIcon } from "../icons/copy-icon";
import { CriticalIcon } from "../icons/critical-icon";
import { InfoIcon } from "../icons/info-icon";
import { WarningIcon } from "../icons/warning-icon";
import { formatAnnotationForClipboard } from "../utils/formatAnnotationForClipboard";
import type { Annotation, AnnotationSeverity } from "../utils/parseReviewTokens";
import { FileLink } from "./FileLink";

interface AnnotationBlockProps {
  annotation: Annotation;
  onNavigate: (file: string, line: number) => void;
}

type MessagePart = { type: "text"; text: string } | { type: "file"; file: string; line?: number };

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
    bg: "bg-warning/10",
    border: "border-warning/30",
    icon: "text-warning",
    label: "Warning",
  },
  critical: {
    bg: "bg-error/10",
    border: "border-error/30",
    icon: "text-error",
    label: "Critical",
  },
  error: {
    bg: "bg-error/10",
    border: "border-error/30",
    icon: "text-error",
    label: "Error",
  },
};

function SeverityIcon(props: { severity: AnnotationSeverity }) {
  if (props.severity === "info") {
    return <InfoIcon size={14} />;
  }
  if (props.severity === "warning") {
    return <WarningIcon size={14} />;
  }
  // critical / error
  return <CriticalIcon size={14} />;
}

/**
 * Displays an annotation with severity styling and action buttons
 */
export const AnnotationBlock: Component<AnnotationBlockProps> = (props) => {
  const [copied, setCopied] = createSignal(false);
  const styles = () => severityStyles[props.annotation.severity];
  const parsedMessage = createMemo<MessagePart[]>(() => {
    const pattern = /\[\[file:([^\]:\s]+)(?::(\d+))?\]\]/g;
    const parts: MessagePart[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(props.annotation.message)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", text: props.annotation.message.slice(lastIndex, match.index) });
      }

      parts.push({
        type: "file",
        file: match[1],
        line: match[2] ? parseInt(match[2], 10) : undefined,
      });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < props.annotation.message.length) {
      parts.push({ type: "text", text: props.annotation.message.slice(lastIndex) });
    }

    return parts.length > 0 ? parts : [{ type: "text", text: props.annotation.message }];
  });

  const fileName = () => {
    const parts = props.annotation.file.split("/");
    return parts[parts.length - 1];
  };

  const handleNavigate = () => {
    props.onNavigate(props.annotation.file, props.annotation.line);
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(formatAnnotationForClipboard(props.annotation));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div class={`my-5 rounded-md border ${styles().border} ${styles().bg} p-3.5`}>
      {/* Header */}
      <div class="flex items-center justify-between gap-2 mb-3">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span class={styles().icon}>
            <SeverityIcon severity={props.annotation.severity} />
          </span>
          <span class={`text-sm font-semibold ${styles().icon}`}>{styles().label}</span>
          <button
            type="button"
            onClick={handleNavigate}
            class="w-full truncate text-left text-xs font-mono text-text-muted hover:text-accent transition-colors"
            title={`${props.annotation.file}:${props.annotation.line}`}
          >
            {fileName()}:{props.annotation.line}
          </button>
        </div>
        <IconButton label={copied() ? "Copied finding" : "Copy finding"} onClick={handleCopy}>
          {copied() ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        </IconButton>
      </div>

      {/* Message */}
      <div class="text-sm text-text leading-relaxed whitespace-pre-wrap">
        <For each={parsedMessage()}>
          {(part) =>
            part.type === "text" ? (
              part.text
            ) : (
              <FileLink
                file={part.file}
                line={part.line}
                onClick={(file, line) => props.onNavigate(file, line ?? 1)}
              />
            )
          }
        </For>
      </div>
    </div>
  );
};
