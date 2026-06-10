import { Show } from "solid-js";

import { Button } from "../design-system";
import { MoonIcon } from "../icons/moon-icon";
import { SunIcon } from "../icons/sun-icon";
import { toggleUiTheme, uiTheme } from "../lib/theme";

export function ThemeToggle() {
  const nextTheme = () => (uiTheme() === "dark" ? "light" : "dark");
  const label = () => `Switch to ${nextTheme()} mode`;

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      class="h-8 w-8 bg-bg text-text-faint hover:border-accent hover:text-accent"
      onClick={toggleUiTheme}
      aria-label={label()}
      title={label()}
    >
      <Show when={uiTheme() === "dark"} fallback={<MoonIcon size={14} />}>
        <SunIcon size={14} />
      </Show>
    </Button>
  );
}
