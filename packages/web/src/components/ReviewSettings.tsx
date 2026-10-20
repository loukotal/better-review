import { Popover } from "../design-system";
import { GearIcon } from "../icons/gear-icon";

export function ReviewSettings(props: {
  automaticOrder: boolean;
  onAutomaticOrderChange: (enabled: boolean) => void;
}) {
  return (
    <Popover label="Review settings" trigger={<GearIcon size={16} />}>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-1 accent-accent"
          checked={props.automaticOrder}
          onChange={(event) => props.onAutomaticOrderChange(event.currentTarget.checked)}
        />
        <span>
          Automatically apply AI review order
          <span class="mt-1 block text-xs text-text-muted">
            Use completed AI orders for this revision. You can still reorder files manually.
          </span>
        </span>
      </label>
    </Popover>
  );
}
