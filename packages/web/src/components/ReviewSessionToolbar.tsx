import type { StoredSession } from "@better-review/shared";

import { Button } from "../design-system";
import { SessionSelector } from "./SessionSelector";

export function ReviewSessionToolbar(props: {
  sessions: StoredSession[];
  activeSessionId: string | null;
  currentHeadSha?: string;
  disabled: boolean;
  creating: boolean;
  onSelect: (id: string) => void;
  onHide: (id: string) => void;
  onNew: () => void;
  onReview: () => void;
  onAdversarial: () => void;
}) {
  return (
    <div role="group" aria-label="Conversation controls" class="space-y-1.5">
      <div class="flex min-w-0 items-center justify-between gap-2">
        <SessionSelector
          sessions={props.sessions}
          activeSessionId={props.activeSessionId}
          currentHeadSha={props.currentHeadSha}
          disabled={props.disabled}
          onSelect={props.onSelect}
          onHide={props.onHide}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.disabled}
          onClick={props.onNew}
          title="Start a fresh conversation. This session stays saved."
        >
          {props.creating ? "Creating…" : "+ New session"}
        </Button>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <Button
          type="button"
          size="sm"
          fullWidth
          disabled={props.disabled}
          onClick={props.onReview}
          title="Run a normal review in this conversation"
        >
          Run review
        </Button>
        <Button
          type="button"
          size="sm"
          fullWidth
          variant="primary"
          disabled={props.disabled}
          onClick={props.onAdversarial}
          aria-label="Run adversarial review"
          title="Run an adversarial review in this conversation"
        >
          Adversarial
        </Button>
      </div>
    </div>
  );
}
