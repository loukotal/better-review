import type { Component } from "solid-js";

import { FileIcon } from "../icons/file-icon";

interface FileLinkProps {
  file: string;
  line?: number;
  onClick: (file: string, line?: number) => void;
}

/**
 * Clickable file reference that scrolls to the file (and optionally line)
 */
export const FileLink: Component<FileLinkProps> = (props) => {
  const fileName = () => {
    const parts = props.file.split("/");
    return parts[parts.length - 1];
  };

  const displayText = () => {
    if (props.line) {
      return `${fileName()}:${props.line}`;
    }
    return fileName();
  };

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    props.onClick(props.file, props.line);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      class="inline-flex items-center gap-1 px-1 py-0.5 text-sm font-mono bg-bg-elevated border border-border text-accent hover:text-accent-bright hover:border-accent transition-colors cursor-pointer"
      title={props.line ? `${props.file}:${props.line}` : props.file}
    >
      <FileIcon size={10} class="opacity-60" />
      <span>{displayText()}</span>
    </button>
  );
};
