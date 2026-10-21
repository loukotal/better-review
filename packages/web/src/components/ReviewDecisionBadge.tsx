import { Show } from "solid-js";

import type { ReviewDecision } from "@better-review/shared";

import { Badge } from "../design-system";
import { CheckIcon } from "../icons/check-icon";

export function ReviewDecisionBadge(props: { decision?: ReviewDecision }) {
  return (
    <Show when={props.decision === "APPROVED"}>
      <Badge
        variant="success"
        class="gap-1 shrink-0"
        title="GitHub's current overall review decision is Approved."
      >
        <CheckIcon size={12} />
        Approved
      </Badge>
    </Show>
  );
}
