# Selection questions in the transcript

`SelectionQuestionMessage` is a display-only renderer for user messages. Pass the
original message content; it recognizes the exact persisted selection prompt
emitted by `formatSelectionQuestion`. Ordinary, malformed, edited, or extended
messages fall back to literal text without removing anything. Message persistence,
model prompts, and retry bodies must remain unchanged.

## Integration handoff

In `packages/web/src/ChatPanel.tsx`, the active user transcript rendering is the
`group.role === "user"` branch near `reviewRequestLabel`, **not** the user branch
inside `MessageContent`. Replace the ordinary user-message `<p>` with:

```tsx
<SelectionQuestionMessage
  content={group.messages[0]!.content}
  onNavigate={(selection) => navigateSelectionSource(selection)}
/>
```

Import from `./components/SelectionQuestionMessage`. Keep the existing "You" label
and review-request rendering. The component already provides the raw-text fallback.

`navigateSelectionSource` is an integration callback, not an existing function.
It receives `SelectionSourceContext`: the exact `file`, `side`, `startLine`,
`endLine`, `revision`, and `text`. Forward it with the conversation's session ID
to revision-aware source navigation. Do not call finding/comment-prefill handlers.
Do not resolve historical filenames against only the current changed-file list:
old paths can belong to renamed or deleted source. Do not replace the exact source
revision with the current chat/diff revision or silently convert the previous
version to the current version. Descriptive unavailable revisions are retained in
the payload and must not be guessed as current HEAD.

The existing `onScrollToFile`/`navigateAnnotation` path assumes the current
(addition) side. It cannot alone carry both source sides or the selected range;
the integrating owner must preserve those fields when adapting navigation.

## Tests

```sh
node --conditions=browser --import tsx --test packages/web/src/lib/selection-question-message.test.ts
pnpm exec tsc -p packages/web/tsconfig.json --noEmit
```

With the web app running, import
`/src/components/SelectionQuestionMessage.browser.tsx` in the browser and run
`testSelectionQuestionMessageInBrowser()`. This mounts and removes a temporary
component; it does not send prompts, navigate the app, or write comments.

The excerpt is intentionally styled plain code using escaped Solid text nodes,
not Markdown or injected HTML. Six lines are shown initially; all selected text
remains available through the accessible expand/collapse control.
