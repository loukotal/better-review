import { createSignal, Show } from "solid-js";

import type { GithubPrScope } from "@better-review/shared";

import { Popover } from "../design-system";
import type { BrowserGithubOperation } from "../lib/github-outbox";
import { GithubOperationDetails } from "./GithubOperationDetails";
import { GithubSyncIndicator, githubSyncLabel, type GithubSyncState } from "./GithubSyncIndicator";
export {
  githubOperationSyncState,
  githubSyncState,
  githubSyncWarning,
  type GithubSyncState,
} from "./GithubSyncIndicator";

/** Optional operation inspector around the pure sync indicator. */
export function GithubSyncStatus(props: {
  status: GithubSyncState;
  iconOnly?: boolean;
  showSynced?: boolean;
  scope?: GithubPrScope;
  operations?: readonly BrowserGithubOperation[];
}) {
  const [open, setOpen] = createSignal(false);
  const label = () => githubSyncLabel(props.status, props.operations);
  return (
    <Show when={props.scope} fallback={<GithubSyncIndicator {...props} />}>
      {(scope) => (
        <GithubSyncIndicator
          {...props}
          renderIcon={(icon) => (
            <Popover
              label={label()}
              trigger={icon}
              triggerSize="icon"
              width={320}
              onOpenChange={setOpen}
            >
              <Show when={open()}>
                <p class="mb-2">{label()}</p>
                <GithubOperationDetails scope={scope()} operations={props.operations ?? []} />
              </Show>
            </Popover>
          )}
        />
      )}
    </Show>
  );
}
