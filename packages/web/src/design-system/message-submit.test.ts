import assert from "node:assert/strict";
import { test } from "node:test";

import { isMessageSubmitShortcut } from "./message-submit";

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    ...overrides,
  } as KeyboardEvent;
}

test("message shortcuts support Cmd and Ctrl without hijacking ordinary Enter", () => {
  assert.equal(isMessageSubmitShortcut(event({ metaKey: true })), true);
  assert.equal(isMessageSubmitShortcut(event({ ctrlKey: true })), true);
  assert.equal(isMessageSubmitShortcut(event()), false);
  assert.equal(isMessageSubmitShortcut(event({ key: "a", metaKey: true })), false);
});

test("composition, held keys, handled events, and extra modifiers do not submit", () => {
  for (const override of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { defaultPrevented: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    assert.equal(isMessageSubmitShortcut(event({ metaKey: true, ...override })), false);
  }
});
