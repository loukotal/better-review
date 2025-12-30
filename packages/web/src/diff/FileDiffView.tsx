import { createSignal, Show, createEffect, on, onCleanup } from "solid-js";
import {
  FileDiff,
  type FileDiffMetadata,
  type AnnotationSide,
  type SelectedLineRange,
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
  highlightedLine?: number;
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.5 5.5L8 9l3.5-3.5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="square"/>
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
  const [pendingComment, setPendingComment] = createSignal<{ startLine: number; endLine: number; side: "LEFT" | "RIGHT" } | null>(null);
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
        lineNumber: pending.endLine, // Attach annotation to the last line of selection
        metadata: { type: "pending", startLine: pending.startLine, endLine: pending.endLine, side: pending.side },
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

  // Highlight line when highlightedLine prop changes
  createEffect(on(
    () => props.highlightedLine,
    (line) => {
      if (!instance || !line) return;
      
      // Try to highlight on additions side first (most common for annotations)
      instance.setSelectedLines({ 
        start: line, 
        end: line, 
        side: "additions" as const 
      });
      
      // Try to scroll the line into view within the shadow DOM
      setTimeout(() => {
        const container = instance.getFileContainer?.() as HTMLElement | undefined;
        const shadowRoot = container?.shadowRoot;
        if (shadowRoot) {
          // Try multiple selectors to find the line element
          // The diff component may use different attributes depending on view mode
          const selectors = [
            `[data-line="${line}"]`,
            `[data-alt-line="${line}"]`,
            `[data-new-line="${line}"]`,
            `.line-new-${line}`,
            `tr[data-line="${line}"]`,
          ];
          
          let lineEl: Element | null = null;
          for (const selector of selectors) {
            lineEl = shadowRoot.querySelector(selector);
            if (lineEl) break;
          }
          
          if (lineEl) {
            lineEl.scrollIntoView({ behavior: "smooth", block: "center" });
          } else {
            // Fallback: try to highlight on deletions side if additions didn't work
            instance.setSelectedLines({ 
              start: line, 
              end: line, 
              side: "deletions" as const 
            });
          }
        }
      }, 100);
    },
    { defer: true }
  ));

  // Helper to render a single comment
  const renderSingleComment = (comment: PRComment, isReply: boolean): string => {
    const indentClass = isReply ? "ml-3 pl-3 border-l border-border" : "";
    return `
      <div class="${indentClass}">
        <div class="flex items-center gap-2 mb-1">
          <img src="${escapeHtml(comment.user.avatar_url)}" class="w-4 h-4 rounded-sm" />
          <span class="text-[11px] text-text">${escapeHtml(comment.user.login)}</span>
          <span class="text-[10px] text-text-faint">${new Date(comment.created_at).toLocaleDateString()}</span>
        </div>
        <div class="text-[11px] text-text-muted whitespace-pre-wrap leading-relaxed">${escapeHtml(comment.body)}</div>
      </div>
    `;
  };

  // Helper to render the reply form
  const renderReplyForm = (commentId: number): string => `
    <div class="ml-3 pl-3 border-l border-accent mt-2">
      <textarea
        placeholder="Write a reply..."
        class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[50px] text-[11px]"
        data-reply-input="${commentId}"
      ></textarea>
      <div class="flex gap-2 mt-1.5">
        <button
          type="button"
          data-submit-reply="${commentId}"
          class="px-2.5 py-1 bg-accent text-black text-[10px] hover:bg-accent-bright disabled:opacity-50 transition-colors"
        >
          Reply
        </button>
        <button
          type="button"
          data-cancel-reply="${commentId}"
          class="px-2.5 py-1 text-text-faint text-[10px] hover:text-text transition-colors"
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
      submitBtn.textContent = "Sending...";
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
      onLineSelectionEnd: (range: SelectedLineRange | null) => {
        // If user has selected text (for copying), don't open comment form
        const textSelection = window.getSelection()?.toString().trim();
        if (textSelection) {
          return;
        }
        
        if (range && range.start && range.end) {
          const side = range.side === "deletions" ? "LEFT" : "RIGHT";
          const startLine = Math.min(range.start, range.end);
          const endLine = Math.max(range.start, range.end);
          setPendingComment({ startLine, endLine, side });
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
          
          div.className = "p-2.5 my-1 mx-2 bg-bg-elevated border border-border";
          
          // Build thread HTML
          let html = `<div class="space-y-2">`;
          
          // Render root comment
          html += renderSingleComment(rootComment, false);
          
          // Render replies (with collapse logic for 3+ replies)
          if (shouldCollapse) {
            // First reply
            if (replies.length > 0) {
              html += `<div class="mt-2">${renderSingleComment(replies[0], true)}</div>`;
            }
            
            const hiddenCount = replies.length - 2;
            
            // Collapsed indicator (if more than 2 replies total)
            if (hiddenCount > 0) {
              html += `
                <button data-expand-thread="${rootComment.id}" 
                        class="ml-3 text-[10px] text-accent hover:text-accent-bright cursor-pointer">
                  +${hiddenCount} more
                </button>
              `;
              
              // Hidden replies (initially hidden)
              html += `<div data-hidden-replies="${rootComment.id}" class="hidden">`;
              for (let i = 1; i < replies.length - 1; i++) {
                html += `<div class="mt-2">${renderSingleComment(replies[i], true)}</div>`;
              }
              html += `</div>`;
            }
            
            // Last reply (if more than 1)
            if (replies.length > 1) {
              html += `<div class="mt-2">${renderSingleComment(replies[replies.length - 1], true)}</div>`;
            }
          } else {
            // Show all replies
            for (const replyComment of replies) {
              html += `<div class="mt-2">${renderSingleComment(replyComment, true)}</div>`;
            }
          }
          
          // Reply button or form
          if (isReplyingToThis) {
            html += renderReplyForm(rootComment.id);
          } else {
            html += `
              <button data-reply-to="${rootComment.id}" 
                      class="mt-2 text-[10px] text-text-faint hover:text-accent transition-colors cursor-pointer">
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
          const lineLabel = metadata.startLine === metadata.endLine 
            ? `Line ${metadata.startLine}` 
            : `Lines ${metadata.startLine}-${metadata.endLine}`;
          div.className = "p-2.5 my-1 mx-2 bg-bg-surface border border-accent";
          div.innerHTML = `
            <div class="text-[10px] text-accent mb-2">
              ${lineLabel}
            </div>
            <textarea
              placeholder="Write a comment..."
              class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[60px] text-[11px]"
              data-comment-input="true"
            ></textarea>
            <div class="flex gap-2 mt-2">
              <button
                type="button"
                data-submit-comment="true"
                class="px-2.5 py-1 bg-accent text-black text-[10px] hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Comment
              </button>
              <button
                type="button"
                data-cancel-comment="true"
                class="px-2.5 py-1 text-text-faint text-[10px] hover:text-text transition-colors"
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
              submitBtn.textContent = "Sending...";
              setSubmitting(true);
              
              try {
                // GitHub API uses the end line for single-line comments
                // For multi-line, we'd need start_line + line params (future enhancement)
                await props.onAddComment(metadata.endLine, metadata.side, body);
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
      case "new": return { label: "+", class: "text-success" };
      case "deleted": return { label: "−", class: "text-error" };
      case "rename-pure":
      case "rename-changed": return { label: "→", class: "text-accent" };
      default: return { label: "~", class: "text-accent" };
    }
  };

  return (
    <div class="border border-border overflow-hidden">
      {/* File Header */}
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed())}
        class="w-full flex items-center gap-2 px-3 py-1.5 bg-bg-elevated hover:bg-bg-surface text-left group"
      >
        {/* Collapse indicator */}
        <span
          class="text-text-faint group-hover:text-text-muted text-[10px]"
          classList={{ "rotate-[-90deg]": collapsed() }}
        >
          <ChevronIcon />
        </span>
        
        {/* Status indicator */}
        <span class={`text-[10px] w-3 ${fileType().class}`}>
          {fileType().label}
        </span>
        
        {/* File path - preserve exact casing */}
        <span class="text-[11px] text-text-muted group-hover:text-text flex-1 truncate">
          {props.file.name}
          {props.file.prevName && (
            <span class="text-text-faint ml-2">← {props.file.prevName}</span>
          )}
        </span>
        
        {/* Comment count */}
        <Show when={props.comments.length > 0}>
          <span class="text-[10px] text-accent">
            {props.comments.length}
          </span>
        </Show>
      </button>
      
      {/* Diff content */}
      <Show when={!collapsed()}>
        <div class="border-t border-border" ref={renderDiff} />
      </Show>
    </div>
  );
}
