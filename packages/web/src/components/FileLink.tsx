import type { Component } from "solid-js";

import { FileIcon } from "../icons/file-icon";

interface FileLinkProps {
  file: string;
  line?: number;
  onClick: (file: string, line?: number) => void;
}

/**
 * Clickable file reference link that scrolls to a file (and optionally a line) in the diff.
 */
export const FileLink: Component<FileLinkProps> = (props) => {
  const displayText = () => {
    const fileName = props.file.split("/").pop() || props.file;
    return props.line ? `${fileName}:${props.line}` : fileName;
  };

  return (
    <button
      type="button"
      onClick={() => props.onClick(props.file, props.line)}
      class="inline-flex max-w-full items-baseline gap-1 rounded px-1 align-bottom text-left font-mono text-[0.9em] text-text-muted underline decoration-border underline-offset-2 hover:text-accent hover:decoration-accent focus-visible:outline focus-visible:outline-accent"
      title={props.line ? `${props.file}:${props.line}` : props.file}
    >
      <FileIcon size={12} class="shrink-0 self-center opacity-60" />
      <span class="truncate">{displayText()}</span>
    </button>
  );
};
