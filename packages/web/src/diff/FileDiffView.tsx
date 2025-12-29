import { createSignal, Show, createEffect, on, onCleanup } from "solid-js";
import {
  FileDiff,
  type FileDiffMetadata,
  type AnnotationSide,
} from "@pierre/diffs";
import {
  type DiffSettings,
  type PRComment,
  type AnnotationMetadata,
  FONT_FAMILY_MAP,
} from "./types";

interface FileDiffViewProps {
  file: FileDiffMetadata;
  comments: PRComment[];
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  settings: DiffSettings;
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.5 5.5L8 9l3.5-3.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  );
}

// Group comments into threads by their root comment
function groupCommentsIntoThreads(comments: PRComment[]) {
  const threads = new Map<number, { root: PRComment; replies: PRComment[] }>();
  
  // First pass: identify root comments (no in_reply_to_id)
  for (const comment of comments) {
    if (!comment.in_reply_to_id) {
      threads.set(comment.id, { root: comment, replies: [] });
    }
  }
  
  // Second pass: group replies under their root
  for (const comment of comments) {
    if (comment.in_reply_to_id) {
      const thread = threads.get(comment.in_reply_to_id);
      if (thread) {
        thread.replies.push(comment);
      }
    }
  }
  
  // Sort replies by created_at
  Array.from(threads.values()).forEach(thread => {
    thread.replies.sort((a, b) => 
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
  });
  
  return threads;
}

// Escape HTML to prevent XSS
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function FileDiffView(props: FileDiffViewProps) {
  let containerRef: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let instance: any;
  const [collapsed, setCollapsed] = createSignal(false);
  const [pendingComment, setPendingComment] = createSignal<{ line: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [pendingReply, setPendingReply] = createSignal<{ commentId: number; line: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  
  // Generate CSS for font injection into shadow DOM
  const getFontCSS = () => {
    const fontFamily = FONT_FAMILY_MAP[props.settings.fontFamily];
    return `:host { --diffs-font-family: ${fontFamily}; } .diffs-code { font-family: ${fontFamily} !important; }`;
  };

  const annotations = () => {
    const result: { side: AnnotationSide; lineNumber: number; metadata: AnnotationMetadata }[] = [];
    const threads = groupCommentsIntoThreads(props.comments);
    
    // Add threads as annotations
    Array.from(threads.values()).forEach(({ root, replies }) => {
      result.push({
        side: (root.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber: root.line,
        metadata: { type: "thread", rootComment: root, replies },
      });
    });
    
    // Add pending new comment form
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

  // Re-render when settings change
  createEffect(on(
    () => ({ ...props.settings }),
    () => {
      if (instance && containerRef) {
        // Clean up and recreate with new settings
        instance.cleanUp();
        containerRef.innerHTML = "";
        createInstance(containerRef);
      }
    },
    { defer: true }
  ));

  // Helper to render a single comment
  const renderSingleComment = (comment: PRComment, isReply: boolean): string => {
    const indentClass = isReply ? "ml-4 pl-3 border-l-2 border-border" : "";
    return `
      <div class="${indentClass}">
        <div class="flex items-center gap-2 mb-1">
          <img src="${escapeHtml(comment.user.avatar_url)}" class="w-5 h-5 rounded-full" />
          <span class="text-sm font-medium text-text">${escapeHtml(comment.user.login)}</span>
          <span class="text-xs text-text-faint">${new Date(comment.created_at).toLocaleDateString()}</span>
        </div>
        <div class="text-sm text-text-muted whitespace-pre-wrap">${escapeHtml(comment.body)}</div>
      </div>
    `;
  };

  // Helper to render the reply form
  const renderReplyForm = (commentId: number): string => `
    <div class="ml-4 pl-3 border-l-2 border-primary mt-3">
      <textarea
        placeholder="Write a reply..."
        class="w-full px-3 py-2 bg-bg border border-border rounded-lg text-text placeholder:text-text-faint focus:outline-none focus:border-border-focus resize-y min-h-[60px]"
        data-reply-input="${commentId}"
      ></textarea>
      <div class="flex gap-2 mt-2">
        <button
          type="button"
          data-submit-reply="${commentId}"
          class="px-3 py-1 bg-primary text-bg text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          Reply
        </button>
        <button
          type="button"
          data-cancel-reply="${commentId}"
          class="px-3 py-1 text-text-muted text-sm hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  `;

  // Helper to attach reply form event handlers
  const attachReplyFormHandlers = (div: HTMLElement, commentId: number) => {
    const textarea = div.querySelector(`[data-reply-input="${commentId}"]`) as HTMLTextAreaElement;
    const submitBtn = div.querySelector(`[data-submit-reply="${commentId}"]`) as HTMLButtonElement;
    const cancelBtn = div.querySelector(`[data-cancel-reply="${commentId}"]`) as HTMLButtonElement;
    
    textarea?.focus();
    
    // Cancel on Escape
    textarea?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPendingReply(null);
        setTimeout(rerender, 0);
      }
    });
    
    submitBtn?.addEventListener("click", async () => {
      const body = textarea?.value?.trim();
      if (!body) return;
      
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting...";
      setSubmitting(true);
      
      try {
        await props.onReplyToComment(commentId, body);
        setPendingReply(null);
        setTimeout(rerender, 0);
      } finally {
        setSubmitting(false);
      }
    });
    
    cancelBtn?.addEventListener("click", () => {
      setPendingReply(null);
      setTimeout(rerender, 0);
    });
  };

  const createInstance = (el: HTMLDivElement) => {
    instance = new FileDiff({
      diffStyle: props.settings.diffStyle,
      theme: props.settings.theme,
      lineDiffType: props.settings.lineDiffType,
      hunkSeparators: "line-info",
      disableFileHeader: true,
      enableLineSelection: true,
      unsafeCSS: getFontCSS(),
      onLineClick: (clickProps: { lineNumber: number; annotationSide: AnnotationSide }) => {
        const { lineNumber, annotationSide } = clickProps;
        if (lineNumber) {
          const side = annotationSide === "deletions" ? "LEFT" : "RIGHT";
          setPendingComment({ line: lineNumber, side });
          setPendingReply(null); // Clear any pending reply
          // Re-render to show the pending comment form
          setTimeout(rerender, 0);
        }
      },
      renderAnnotation: (annotation: { metadata: AnnotationMetadata }) => {
        const { metadata } = annotation;
        const div = document.createElement("div");
        
        if (metadata.type === "thread") {
          const { rootComment, replies } = metadata;
          const shouldCollapse = replies.length >= 3;
          const reply = pendingReply();
          const isReplyingToThis = reply?.commentId === rootComment.id;
          
          div.className = "p-3 my-1 mx-2 bg-bg-elevated rounded border border-border";
          
          // Build thread HTML
          let html = `<div class="space-y-3">`;
          
          // Render root comment
          html += renderSingleComment(rootComment, false);
          
          // Render replies (with collapse logic for 3+ replies)
          if (shouldCollapse) {
            // First reply
            if (replies.length > 0) {
              html += `<div class="mt-3">${renderSingleComment(replies[0], true)}</div>`;
            }
            
            const hiddenCount = replies.length - 2;
            
            // Collapsed indicator (if more than 2 replies total)
            if (hiddenCount > 0) {
              html += `
                <button data-expand-thread="${rootComment.id}" 
                        class="ml-4 text-xs text-primary hover:underline cursor-pointer">
                  Show ${hiddenCount} more ${hiddenCount === 1 ? "reply" : "replies"}
                </button>
              `;
              
              // Hidden replies (initially hidden)
              html += `<div data-hidden-replies="${rootComment.id}" class="hidden">`;
              for (let i = 1; i < replies.length - 1; i++) {
                html += `<div class="mt-3">${renderSingleComment(replies[i], true)}</div>`;
              }
              html += `</div>`;
            }
            
            // Last reply (if more than 1)
            if (replies.length > 1) {
              html += `<div class="mt-3">${renderSingleComment(replies[replies.length - 1], true)}</div>`;
            }
          } else {
            // Show all replies
            for (const replyComment of replies) {
              html += `<div class="mt-3">${renderSingleComment(replyComment, true)}</div>`;
            }
          }
          
          // Reply button or form
          if (isReplyingToThis) {
            html += renderReplyForm(rootComment.id);
          } else {
            html += `
              <button data-reply-to="${rootComment.id}" 
                      class="mt-2 text-xs text-text-muted hover:text-primary transition-colors cursor-pointer">
                Reply
              </button>
            `;
          }
          
          html += `</div>`;
          div.innerHTML = html;
          
          // Attach event listeners
          setTimeout(() => {
            // Reply button
            const replyBtn = div.querySelector(`[data-reply-to="${rootComment.id}"]`);
            replyBtn?.addEventListener("click", () => {
              setPendingReply({ 
                commentId: rootComment.id, 
                line: rootComment.line, 
                side: rootComment.side 
              });
              setPendingComment(null); // Clear any pending new comment
              setTimeout(rerender, 0);
            });
            
            // Expand thread button
            const expandBtn = div.querySelector(`[data-expand-thread="${rootComment.id}"]`);
            const hiddenReplies = div.querySelector(`[data-hidden-replies="${rootComment.id}"]`);
            expandBtn?.addEventListener("click", () => {
              hiddenReplies?.classList.remove("hidden");
              expandBtn.classList.add("hidden");
            });
            
            // Reply form handlers (if showing)
            if (isReplyingToThis) {
              attachReplyFormHandlers(div, rootComment.id);
            }
          }, 0);
          
        } else if (metadata.type === "pending") {
          // Pending comment form (new comment, not a reply)
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
            const textarea = div.querySelector("[data-comment-input]") as HTMLTextAreaElement;
            const submitBtn = div.querySelector("[data-submit-comment]") as HTMLButtonElement;
            const cancelBtn = div.querySelector("[data-cancel-comment]") as HTMLButtonElement;
            
            textarea?.focus();
            
            // Cancel on Escape
            textarea?.addEventListener("keydown", (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setPendingComment(null);
                setTimeout(rerender, 0);
              }
            });
            
            submitBtn?.addEventListener("click", async () => {
              const body = textarea?.value?.trim();
              if (!body) return;
              
              submitBtn.disabled = true;
              submitBtn.textContent = "Submitting...";
              setSubmitting(true);
              
              try {
                await props.onAddComment(metadata.line, metadata.side, body);
                setPendingComment(null);
                setTimeout(rerender, 0);
              } finally {
                setSubmitting(false);
              }
            });
            
            cancelBtn?.addEventListener("click", () => {
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

  const renderDiff = (el: HTMLDivElement) => {
    containerRef = el;
    createInstance(el);
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
          <ChevronIcon />
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
