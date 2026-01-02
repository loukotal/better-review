import { createSignal, Show, createEffect, on, onCleanup, createMemo } from "solid-js";
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
import { GITHUB_ICON } from "../icons";

// Large file thresholds
const LARGE_FILE_LINE_THRESHOLD = 2000;

// Patterns for generated/lock files that are rarely useful to review
const GENERATED_FILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /Podfile\.lock$/,
  /Gemfile\.lock$/,
  /composer\.lock$/,
  /\.min\.js$/,
  /\.min\.css$/,
];

interface FileDiffViewProps {
  file: FileDiffMetadata;
  comments: PRComment[];
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string) => Promise<unknown>;
  onReplyToComment: (commentId: number, body: string) => Promise<unknown>;
  onEditComment: (commentId: number, body: string) => Promise<unknown>;
  onDeleteComment: (commentId: number) => Promise<unknown>;
  currentUser: string | null;
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

  // Detect large or generated files
  const totalLines = createMemo(() =>
    props.file.hunks?.reduce((acc, h) => acc + (h.additionLines ?? 0) + (h.deletionLines ?? 0), 0) ?? 0
  );
  const isLargeFile = createMemo(() => totalLines() > LARGE_FILE_LINE_THRESHOLD);
  const isGeneratedFile = createMemo(() =>
    GENERATED_FILE_PATTERNS.some(p => p.test(props.file.name))
  );
  const shouldAutoCollapse = createMemo(() => isLargeFile() || isGeneratedFile());

  const [collapsed, setCollapsed] = createSignal(shouldAutoCollapse());
  const [pendingComment, setPendingComment] = createSignal<{ startLine: number; endLine: number; side: "LEFT" | "RIGHT" } | null>(null);
  const [pendingReply, setPendingReply] = createSignal<{ commentId: number; line: number | null; side: "LEFT" | "RIGHT" } | null>(null);
  const [pendingEdit, setPendingEdit] = createSignal<{ commentId: number; body: string } | null>(null);
  const [editError, setEditError] = createSignal<string | null>(null);
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
      // Use line if available, otherwise fall back to original_line for outdated comments
      const lineNumber = root.line ?? root.original_line;
      // Skip comments without any line information
      if (lineNumber === null) return;
      
      result.push({
        side: (root.side === "LEFT" ? "deletions" : "additions") as AnnotationSide,
        lineNumber,
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

  // Re-render when comments change (length or content)
  createEffect(on(
    () => props.comments.map(c => `${c.id}:${c.body}`).join("|"),
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
  const renderSingleComment = (comment: PRComment, isReply: boolean, isEditing: boolean): string => {
    const indentClass = isReply ? "ml-3 pl-3 border-l border-border" : "";

    if (isEditing) {
      const error = editError();
      const errorHtml = error
        ? `<div class="mt-2 px-2 py-1.5 border border-red-500/50 bg-red-500/10 text-red-400 text-sm">${escapeHtml(error)}</div>`
        : "";
      return `
        <div class="${indentClass}">
          <div class="flex items-center gap-2 mb-1">
            <img src="${escapeHtml(comment.user.avatar_url)}" class="w-4 h-4 rounded-sm" />
            <span class="text-sm text-text">${escapeHtml(comment.user.login)}</span>
            <span class="text-sm text-accent">editing</span>
          </div>
          <textarea
            class="w-full px-2 py-1.5 bg-bg border border-accent text-text focus:border-accent resize-y min-h-[60px] text-sm"
            data-edit-input="${comment.id}"
          >${escapeHtml(comment.body)}</textarea>
          <div class="flex gap-2 mt-1.5">
            <button
              type="button"
              data-submit-edit="${comment.id}"
              class="px-2.5 py-1 bg-accent text-black text-sm hover:bg-accent-bright disabled:opacity-50 transition-colors"
            >
              Save
            </button>
            <button
              type="button"
              data-cancel-edit="${comment.id}"
              class="px-2.5 py-1 text-text-faint text-sm hover:text-text transition-colors"
            >
              Cancel
            </button>
          </div>
          ${errorHtml}
        </div>
      `;
    }

    const isOwnComment = props.currentUser && comment.user.login === props.currentUser;
    const isOutdated = comment.line === null;
    const actionsHtml = isOwnComment ? `
      <div class="flex items-center gap-2 ml-auto text-xs">
        <button
          type="button"
          data-edit-comment="${comment.id}"
          class="text-text-faint hover:text-accent transition-colors"
        >
          Edit
        </button>
        <button
          type="button"
          data-delete-comment="${comment.id}"
          class="text-text-faint hover:text-red-400 transition-colors"
        >
          Delete
        </button>
      </div>
    ` : "";
    const outdatedBadge = isOutdated
      ? `<span class="px-1.5 py-0.5 text-[9px] bg-amber-500/20 text-amber-400 rounded" title="This comment was made on a line that has since changed">outdated</span>`
      : "";

    return `
      <div class="${indentClass}" id="comment-${comment.id}">
        <div class="flex items-center gap-2 mb-1">
          <img src="${escapeHtml(comment.user.avatar_url)}" class="w-4 h-4 rounded-sm" />
          <span class="text-sm text-text">${escapeHtml(comment.user.login)}</span>
          <a
            href="#comment-${comment.id}"
            class="text-sm text-text-faint hover:text-accent transition-colors"
            title="Link to comment"
          >${new Date(comment.created_at).toLocaleDateString()}</a>
          <a
            href="${escapeHtml(comment.html_url)}"
            target="_blank"
            rel="noopener noreferrer"
            class="text-text-faint hover:text-accent transition-colors"
            title="View on GitHub"
          >${GITHUB_ICON}</a>
          ${actionsHtml}
        </div>
        <div class="text-sm text-text-muted whitespace-pre-wrap leading-relaxed">${escapeHtml(comment.body)}</div>
      </div>
    `;
  };

  // Helper to render the reply form
  const renderReplyForm = (commentId: number): string => `
    <div class="ml-3 pl-3 border-l border-accent mt-2">
      <textarea
        placeholder="Write a reply..."
        class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[50px] text-sm"
        data-reply-input="${commentId}"
      ></textarea>
      <div class="flex gap-2 mt-1.5">
        <button
          type="button"
          data-submit-reply="${commentId}"
          class="px-2.5 py-1 bg-accent text-black text-xs hover:bg-accent-bright disabled:opacity-50 transition-colors"
        >
          Reply
        </button>
        <button
          type="button"
          data-cancel-reply="${commentId}"
          class="px-2.5 py-1 text-text-faint text-sm hover:text-text transition-colors"
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
        // Clear any text selection so next line click can open comment form
        window.getSelection()?.removeAllRanges();
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

  // Helper to attach edit form event handlers
  const attachEditFormHandlers = (div: HTMLElement, commentId: number) => {
    const textarea = div.querySelector(`[data-edit-input="${commentId}"]`) as HTMLTextAreaElement;
    const submitBtn = div.querySelector(`[data-submit-edit="${commentId}"]`) as HTMLButtonElement;
    const cancelBtn = div.querySelector(`[data-cancel-edit="${commentId}"]`) as HTMLButtonElement;

    textarea?.focus();
    // Move cursor to end
    if (textarea) {
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    }

    // Cancel on Escape
    textarea?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPendingEdit(null);
        setTimeout(rerender, 0);
      }
    });

    submitBtn?.addEventListener("click", async () => {
      const body = textarea?.value?.trim();
      if (!body) return;

      setEditError(null);
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving...";

      try {
        const result = await props.onEditComment(commentId, body) as { error?: string };
        if (result?.error) {
          throw new Error(result.error);
        }
        setPendingEdit(null);
        setEditError(null);
        window.getSelection()?.removeAllRanges();
        setTimeout(rerender, 0);
      } catch (err) {
        setEditError(err instanceof Error ? err.message : "Failed to save");
        setTimeout(rerender, 0);
      }
    });

    cancelBtn?.addEventListener("click", () => {
      setPendingEdit(null);
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
        if (range && range.start && range.end) {
          // Clear any existing text selection so it doesn't block future interactions
          window.getSelection()?.removeAllRanges();

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
          const edit = pendingEdit();
          const isReplyingToThis = reply?.commentId === rootComment.id;
          const allComments = [rootComment, ...replies];
          const editingCommentId = edit?.commentId;

          div.className = "p-2.5 my-1 mx-2 bg-bg-elevated border border-border";

          // Build thread HTML
          let html = `<div class="space-y-2">`;

          // Render root comment
          html += renderSingleComment(rootComment, false, editingCommentId === rootComment.id);

          // Render replies (with collapse logic for 3+ replies)
          if (shouldCollapse) {
            // First reply
            if (replies.length > 0) {
              html += `<div class="mt-2">${renderSingleComment(replies[0], true, editingCommentId === replies[0].id)}</div>`;
            }

            const hiddenCount = replies.length - 2;

            // Collapsed indicator (if more than 2 replies total)
            if (hiddenCount > 0) {
              html += `
                <button data-expand-thread="${rootComment.id}"
                        class="ml-3 text-sm text-accent hover:text-accent-bright cursor-pointer">
                  +${hiddenCount} more
                </button>
              `;

              // Hidden replies (initially hidden)
              html += `<div data-hidden-replies="${rootComment.id}" class="hidden">`;
              for (let i = 1; i < replies.length - 1; i++) {
                html += `<div class="mt-2">${renderSingleComment(replies[i], true, editingCommentId === replies[i].id)}</div>`;
              }
              html += `</div>`;
            }

            // Last reply (if more than 1)
            if (replies.length > 1) {
              const lastReply = replies[replies.length - 1];
              html += `<div class="mt-2">${renderSingleComment(lastReply, true, editingCommentId === lastReply.id)}</div>`;
            }
          } else {
            // Show all replies
            for (const replyComment of replies) {
              html += `<div class="mt-2">${renderSingleComment(replyComment, true, editingCommentId === replyComment.id)}</div>`;
            }
          }
          
          // Reply button or form
          if (isReplyingToThis) {
            html += renderReplyForm(rootComment.id);
          } else {
            html += `
              <button data-reply-to="${rootComment.id}" 
                      class="mt-2 text-xs text-text-faint hover:text-accent transition-colors cursor-pointer">
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
              setPendingComment(null);
              setPendingEdit(null);
              setTimeout(rerender, 0);
            });

            // Edit buttons for all comments in thread
            for (const comment of allComments) {
              const editBtn = div.querySelector(`[data-edit-comment="${comment.id}"]`);
              editBtn?.addEventListener("click", () => {
                setPendingEdit({ commentId: comment.id, body: comment.body });
                setPendingReply(null);
                setPendingComment(null);
                setEditError(null);
                setTimeout(rerender, 0);
              });

              const deleteBtn = div.querySelector(`[data-delete-comment="${comment.id}"]`);
              deleteBtn?.addEventListener("click", async () => {
                if (!confirm("Delete this comment?")) return;
                try {
                  const result = await props.onDeleteComment(comment.id) as { error?: string };
                  if (result?.error) {
                    alert(result.error);
                  }
                } catch (err) {
                  alert(err instanceof Error ? err.message : "Failed to delete");
                }
              });

              // If this comment is being edited, attach form handlers
              if (editingCommentId === comment.id) {
                attachEditFormHandlers(div, comment.id);
              }
            }

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
            <div class="text-sm text-accent mb-2">
              ${lineLabel}
            </div>
            <textarea
              placeholder="Write a comment..."
              class="w-full px-2 py-1.5 bg-bg border border-border text-text placeholder:text-text-faint focus:border-accent resize-y min-h-[60px] text-sm"
              data-comment-input="true"
            ></textarea>
            <div class="flex gap-2 mt-2">
              <button
                type="button"
                data-submit-comment="true"
                class="px-2.5 py-1 bg-accent text-black text-sm hover:bg-accent-bright disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Comment
              </button>
              <button
                type="button"
                data-cancel-comment="true"
                class="px-2.5 py-1 text-text-faint text-sm hover:text-text transition-colors"
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
                // Clear any text selection so next line click can open comment form
                window.getSelection()?.removeAllRanges();
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
          class="text-text-faint group-hover:text-text-muted text-sm"
          classList={{ "rotate-[-90deg]": collapsed() }}
        >
          <ChevronIcon />
        </span>
        
        {/* Status indicator */}
        <span class={`text-sm w-3 ${fileType().class}`}>
          {fileType().label}
        </span>
        
        {/* File path - preserve exact casing */}
        <span class="text-sm text-text-muted group-hover:text-text flex-1 truncate">
          {props.file.name}
          {props.file.prevName && (
            <span class="text-text-faint ml-2">← {props.file.prevName}</span>
          )}
        </span>
        
        {/* Large/generated file indicator */}
        <Show when={shouldAutoCollapse()}>
          <span class="text-sm text-text-faint">
            {isGeneratedFile() ? "generated" : `${totalLines()} lines`}
          </span>
        </Show>

        {/* Comment count */}
        <Show when={props.comments.length > 0}>
          <span class="text-sm text-accent">
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
