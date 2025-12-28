import { For, onCleanup, createSignal, Show, createEffect, on } from "solid-js";
import {
  FileDiff,
  parsePatchFiles,
  SVGSpriteSheet,
  type FileDiffMetadata,
  type DiffLineAnnotation,
  type AnnotationSide,
} from "@pierre/diffs";

export interface PRComment {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
}

interface Props {
  rawDiff: string;
  comments: PRComment[];
  loadingComments?: boolean;
  onAddComment: (filePath: string, line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
}

type AnnotationMetadata = 
  | { type: "comment"; comment: PRComment }
  | { type: "pending"; line: number; side: "LEFT" | "RIGHT" };

function FileDiffView(props: { 
  file: FileDiffMetadata; 
  comments: PRComment[];
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
}) {
  let containerRef: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any;
  const [collapsed, setCollapsed] = createSignal(false);
  const [pendingComment, setPendingComment] = createSignal<{ line: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const annotations = () => {
    const result: { side: AnnotationSide; lineNumber: number; metadata: AnnotationMetadata }[] = [];
    
    // Add existing comments
    for (const comment of props.comments) {
      result.push({
        side: (comment.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber: comment.line,
        metadata: { type: "comment", comment },
      });
    }
    
    // Add pending comment form
    const pending = pendingComment();
    if (pending) {
      result.push({
        side: (pending.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber: pending.line,
        metadata: { type: "pending", line: pending.line, side: pending.side },
      });
    }
    
    return result;
  };

  const rerender = () => {
    if (instance && containerRef) {
      instance.render({
        fileDiff: props.file,
        lineAnnotations: annotations(),
        forceRender: true,
      });
    }
  };

  // Re-render when comments change
  createEffect(on(
    () => props.comments.length,
    () => {
      setTimeout(rerender, 0);
    },
    { defer: true }
  ));

  const renderDiff = (el: HTMLDivElement) => {
    containerRef = el;
    
    instance = new FileDiff({
      diffStyle: "split",
      theme: "github-dark",
      lineDiffType: "word",
      hunkSeparators: "line-info",
      disableFileHeader: true,
      enableLineSelection: true,
      onLineClick: (clickProps: { lineNumber: number; annotationSide: AnnotationSide }) => {
        const { lineNumber, annotationSide } = clickProps;
        if (lineNumber) {
          const side = annotationSide === "deletions" ? "LEFT" : "RIGHT";
          setPendingComment({ line: lineNumber, side });
          // Re-render to show the pending comment form
          setTimeout(rerender, 0);
        }
      },
      renderAnnotation: (annotation: { metadata: AnnotationMetadata }) => {
        const { metadata } = annotation;
        const div = document.createElement("div");
        
        if (metadata.type === "comment") {
          const { comment } = metadata;
          div.className = "p-3 my-1 mx-2 bg-bg-elevated rounded border border-border";
          div.innerHTML = `
            <div class="flex items-center gap-2 mb-2">
              <img src="${comment.user.avatar_url}" class="w-5 h-5 rounded-full" />
              <span class="text-sm font-medium text-text">${comment.user.login}</span>
              <span class="text-xs text-text-faint">${new Date(comment.created_at).toLocaleDateString()}</span>
            </div>
            <div class="text-sm text-text-muted whitespace-pre-wrap">${comment.body}</div>
          `;
        } else {
          // Pending comment form
          div.className = "p-3 my-1 mx-2 bg-bg-surface rounded border border-primary";
          div.innerHTML = `
            <div class="text-sm text-text-muted mb-2">
              Comment on line ${metadata.line} (${metadata.side === "LEFT" ? "old" : "new"})
            </div>
            <textarea
              placeholder="Write a comment..."
              class="w-full px-3 py-2 bg-bg border border-border rounded-lg text-text placeholder:text-text-faint focus:outline-none focus:border-border-focus resize-y min-h-[80px]"
              data-comment-input="true"
            ></textarea>
            <div class="flex gap-2 mt-2">
              <button
                type="button"
                data-submit-comment="true"
                class="px-4 py-1.5 bg-primary text-bg text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Add comment
              </button>
              <button
                type="button"
                data-cancel-comment="true"
                class="px-4 py-1.5 text-text-muted text-sm hover:text-text transition-colors"
              >
                Cancel
              </button>
            </div>
          `;
          
          // Add event listeners after a tick
          setTimeout(() => {
            const textarea = div.querySelector('[data-comment-input]') as HTMLTextAreaElement;
            const submitBtn = div.querySelector('[data-submit-comment]') as HTMLButtonElement;
            const cancelBtn = div.querySelector('[data-cancel-comment]') as HTMLButtonElement;
            
            textarea?.focus();
            
            submitBtn?.addEventListener('click', async () => {
              const body = textarea?.value?.trim();
              if (!body) return;
              
              submitBtn.disabled = true;
              submitBtn.textContent = 'Submitting...';
              setSubmitting(true);
              
              try {
                await props.onAddComment(metadata.line, metadata.side, body);
                setPendingComment(null);
                setTimeout(rerender, 0);
              } finally {
                setSubmitting(false);
              }
            });
            
            cancelBtn?.addEventListener('click', () => {
              setPendingComment(null);
              setTimeout(rerender, 0);
            });
          }, 0);
        }
        
        return div;
      },
    });

    instance.render({
      fileDiff: props.file,
      containerWrapper: el,
      lineAnnotations: annotations(),
    });
  };

  onCleanup(() => instance?.cleanUp());

  const fileType = () => {
    switch (props.file.type) {
      case "new": return { label: "Added", class: "text-diff-add-text" };
      case "deleted": return { label: "Deleted", class: "text-diff-remove-text" };
      case "rename-pure":
      case "rename-changed": return { label: "Renamed", class: "text-primary" };
      default: return { label: "Modified", class: "text-text-muted" };
    }
  };

  return (
    <div class="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed())}
        class="w-full flex items-center gap-3 px-4 py-2 bg-bg-elevated hover:bg-bg-surface transition-colors text-left"
      >
        <span
          class="text-text-muted transition-transform"
          classList={{ "rotate-[-90deg]": collapsed() }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.5 5.5L8 9l3.5-3.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span class="font-mono text-sm text-text flex-1 truncate">
          {props.file.name}
          {props.file.prevName && (
            <span class="text-text-muted"> (from {props.file.prevName})</span>
          )}
        </span>
        <span class={`text-xs ${fileType().class}`}>{fileType().label}</span>
      </button>
      <Show when={!collapsed()}>
        <div ref={renderDiff} />
      </Show>
    </div>
  );
}

export function DiffViewer(props: Props) {
  const files = () => {
    const patches = parsePatchFiles(props.rawDiff);
    // Flatten all files from all patches
    return patches.flatMap((p) => p.files);
  };

  const commentsForFile = (fileName: string) => {
    return props.comments.filter((c) => c.path === fileName);
  };

  return (
    <div>
      <div innerHTML={SVGSpriteSheet} style="display:none" />
      
      <Show when={props.loadingComments}>
        <div class="mb-4 px-4 py-2 bg-bg-surface border border-border rounded-lg text-text-muted text-sm flex items-center gap-2">
          <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading comments...
        </div>
      </Show>
      
      <div class="flex flex-col gap-4">
        <For each={files()}>
          {(file) => (
            <FileDiffView
              file={file}
              comments={commentsForFile(file.name)}
              onAddComment={(line, side, body) => props.onAddComment(file.name, line, side, body)}
            />
          )}
        </For>
      </div>
    </div>
  );
}
