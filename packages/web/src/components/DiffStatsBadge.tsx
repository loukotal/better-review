import type { FileDiffMetadata } from "@pierre/diffs";
import { createMemo, Show } from "solid-js";

import { getTotalDiffStats, hasDiffChanges } from "../lib/diff-stats";

/** GitHub-style `+A −D` PR overview badge for a set of changed files. */
export function DiffStatsBadge(props: { files: FileDiffMetadata[]; class?: string }) {
  const stats = createMemo(() => getTotalDiffStats(props.files));

  return (
    <Show when={hasDiffChanges(stats())}>
      <span
        class={`flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums ${props.class ?? ""}`}
        title={`${stats().additions} added, ${stats().deletions} removed across ${props.files.length} files`}
      >
        <span class="text-success">+{stats().additions}</span>
        <span class="text-error">−{stats().deletions}</span>
      </span>
    </Show>
  );
}
