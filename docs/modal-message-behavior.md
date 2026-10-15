# Modal and message-editor behavior audit

## Shared contracts

- `design-system/Dialog.tsx`: backdrop dismissal requires both pointer-down and click outside the dialog's bounding box, targeted at the dialog itself. Padding and descendants stay inside; dragging from inside to outside does not close. Native Escape still calls `onClose`. This covers historical `SourceDialog`, the agent-review discard confirmation, and the design-system example.
- `design-system/Popover.tsx`: existing native `popover="auto"` already supplies outside dismissal and Escape. No custom document-wide submission listener was added. Covers approval, model/session selectors, diff settings, review actions, update notices, PR description/status and agent-session details.
- `design-system/MessageForm.tsx` + `message-submit.ts`: opt-in native forms only. Cmd/Ctrl+Enter from an editable textarea calls `requestSubmit` with the actual primary submit button. Native validation and submitter identity are preserved. Disabled controls/fieldsets, readonly editors, pending submissions, key repeats, composition (including legacy 229), handled events and extra modifiers do not submit. Search inputs and unrelated forms are not affected.
- A form with multiple submit actions may mark `data-default-submit`; a disabled default never falls through to another action. Async submissions are locked until their returned promise settles, in addition to consumer busy guards.

## Consumer checklist

- [x] `CommentView`: comment editing uses `MessageForm` and a submit button; Escape cancels only when idle and not composing.
- [x] `CommentThread` / `ReplyForm`: native reply submission, empty/busy guards and failed draft retention.
- [x] `PendingCommentForm`: native inline-comment submission; existing initial body, save errors and draft callbacks preserved. Used by diff rendering, so shared changes also cover the excluded `FileDiffView` without editing it.
- [x] `PrCommentsPanel`: both top-level conversation comments and quoted replies.
- [x] `ApproveButton`: optional approval comment; native form submission instead of a direct keyboard mutation. Existing errors, busy guard, PR-switch behavior and retained comments remain.
- [x] `AskSelectionComposer`: native message form; busy/stale/disabled/empty constraints retained.
- [x] `SelectionBubble` / `AnchoredSelectionEditor`: outside click and Escape close the expanded floating editor to a compact **Resume question** action. Explicit Dismiss still discards. App-owned question, target, sending/error state and admission/retry identity survive outside closure and source-modal relocation. Inside controls do not close the editor.
- [x] `AgentReviewPage`: text-selection note creation, note editing and review verdict use `MessageForm`. Clicking outside an open note composer now closes it even within the document content. Existing cancellation/draft clearing behavior otherwise remains. Inline diff note/reply forms inherit the shared comment consumers.
- [x] Agent-review verdict shortcut explicitly chooses **Request Changes**, not approval. Clicking **Approve** retains its own native submitter. Both actions obey `canSubmit` and busy state; existing discard-confirmation flow remains.
- [x] `SourceDialog`: inherits shared backdrop/Escape behavior without editing the concurrently modified file.
- [x] `App.tsx`: PR URL loader intentionally remains a normal form, not a message shortcut target. Shared source/dialog/editor behavior is inherited.
- [x] `AnnotationBlock.tsx`: no message textarea; Enter/Space activates comment-prefill navigation. No edit needed; resulting comment editor inherits `PendingCommentForm`.
- [x] `FileDiffView.tsx`: no independent message keyboard handler; rendered comment components inherit shared behavior. No edit needed.
- [x] `ChatPanel.tsx`: integrated `MessageForm`. Plain Enter requests native submission; Cmd/Ctrl+Enter uses the shared shortcut. IME/repeated keys are excluded, asynchronous admission is locked, and Send disables during selection submission. Full-App browser checks exercise ordinary Enter, modified Enter, duplicate admission, IME, repeats and Shift+Enter with intercepted transport only.

ChatPanel integration is verified alongside the shared component contracts below.

## Verification

- `message-submit.test.ts`: shortcut recognition and IME/repeat/modifier exclusions.
- `message-behavior.browser.tsx`: real browser DOM validation, disabled and readonly controls, search exclusion, duplicate pending submission, default/explicit submitter identity, actual inline comment error/retry, comment editing, thread reply and conversation-comment consumers; shared dialog inside/outside/drag/Escape contracts; native popover inside/close behavior. Uses only local callbacks, no GitHub/LLM mutation.
- `AskSelectionComposer.browser.tsx`: busy shortcut rejection, composition rejection, Ctrl+Enter sending and duplicate admission across fresh drafts.
- `AnchoredSelectionEditor.browser.tsx`: outside close/resume retains question/target, failures and retry key, modal relocation, stale scope and successful dismissal.
- `mountDismissalFixtureInBrowser` was also checked using trusted Chrome DevTools Protocol input: inside dialog click stays open; outside click closes; Escape closes; native auto-popover outside click and Escape close (5 assertions). No paid model request or real review submission is used for verification.
