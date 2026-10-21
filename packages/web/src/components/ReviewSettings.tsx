import { createSignal, Show } from "solid-js";

import { useGithubQueue } from "../context/GithubQueueContext";
import { Popover, Select } from "../design-system";
import { GearIcon } from "../icons/gear-icon";
import { getGithubSyncTimeoutMs, setGithubSyncTimeoutMs } from "../lib/github-queue-settings";
import { githubWrites } from "../lib/github-writes";

export function ReviewSettings(
  props: {
    automaticOrder?: boolean;
    onAutomaticOrderChange?: (enabled: boolean) => void;
  } = {},
) {
  const [timeout, setTimeout] = createSignal(getGithubSyncTimeoutMs());
  const queue = useGithubQueue();
  return (
    <Popover label="Review settings" trigger={<GearIcon size={16} />}>
      <div class="space-y-4">
        <label class="block text-sm">
          <span class="mb-1 block">GitHub sync timeout</span>
          <Select
            aria-label="GitHub sync timeout"
            disabled={!!queue?.batchBusy?.()}
            value={String(timeout())}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              setGithubSyncTimeoutMs(value);
              githubWrites.setQueueTimeoutMs(value);
              setTimeout(value);
            }}
          >
            {[5, 15, 30, 60].map((minutes) => (
              <option value={String(minutes * 60_000)}>{minutes} minutes</option>
            ))}
          </Select>
          <span class="mt-1 block text-xs text-text-muted">
            Applies to new actions and retries.
          </span>
        </label>
        <Show when={props.onAutomaticOrderChange}>
          <label class="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              class="mt-1 accent-accent"
              checked={props.automaticOrder}
              onChange={(event) => props.onAutomaticOrderChange?.(event.currentTarget.checked)}
            />
            <span>
              Automatically apply AI review order
              <span class="mt-1 block text-xs text-text-muted">
                Use completed AI orders for this revision. You can still reorder files manually.
              </span>
            </span>
          </label>
        </Show>
      </div>
    </Popover>
  );
}
