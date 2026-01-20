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
      class="inline-flex mb-0.5 items-center gap-1 px-1 py-0.5 font-bold text-text hover:text-white hover:underline font-mono text-sm cursor-pointer bg-transparent border border-text-muted"
      title={props.line ? `${props.file}:${props.line}` : props.file}
    >
      <FileIcon size={12} class="opacity-60" />
      {displayText()}
    </button>
  );
};
