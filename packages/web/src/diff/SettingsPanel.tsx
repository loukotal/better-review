import { createSignal, For, Show } from "solid-js";

import { Button, Select } from "../design-system";
import { GearIcon } from "../icons/gear-icon";
import {
  type DiffSettings,
  type DiffTheme,
  type LineDiffType,
  type FontFamily,
  type AccentColor,
  FONT_FAMILY_MAP,
  FONT_LABELS,
  THEME_LABELS,
  LINE_DIFF_LABELS,
  ACCENT_LABELS,
  ACCENT_THEME_VARS,
} from "./types";

interface SettingsPanelProps {
  settings: DiffSettings;
  onChange: (settings: DiffSettings) => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [open, setOpen] = createSignal(false);

  const update = <K extends keyof DiffSettings>(key: K, value: DiffSettings[K]) => {
    props.onChange({ ...props.settings, [key]: value });
  };

  return (
    <div class="relative">
      <Button
        type="button"
        onClick={() => setOpen(!open())}
        variant="ghost"
        size="icon"
        class="text-text-faint hover:text-accent"
        title="Settings"
      >
        <GearIcon size={14} />
      </Button>

      <Show when={open()}>
        {/* Backdrop */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />

        {/* Panel */}
        <div class="absolute top-full right-0 mt-1 z-50 w-[260px] border border-border bg-bg-surface shadow-lg shadow-black/50">
          {/* Panel Header */}
          <div class="px-3 py-2 border-b border-border flex items-center justify-between">
            <span class="text-sm text-text">Settings</span>
            <Button onClick={() => setOpen(false)} variant="ghost" size="xs" class="leading-none">
              ×
            </Button>
          </div>

          <div class="p-3 flex flex-col gap-3">
            {/* View Mode */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">View</label>
              <div class="flex">
                <Button
                  type="button"
                  onClick={() => update("diffStyle", "split")}
                  variant="secondary"
                  size="md"
                  fullWidth
                  class={
                    props.settings.diffStyle === "split"
                      ? "bg-primary text-primary-text border-primary hover:text-primary-text hover:border-primary"
                      : "bg-bg text-text-muted"
                  }
                >
                  Split
                </Button>
                <Button
                  type="button"
                  onClick={() => update("diffStyle", "unified")}
                  variant="secondary"
                  size="md"
                  fullWidth
                  class={`border-l-0 ${
                    props.settings.diffStyle === "unified"
                      ? "bg-primary text-primary-text border-primary hover:text-primary-text hover:border-primary"
                      : "bg-bg text-text-muted"
                  }`}
                >
                  Unified
                </Button>
              </div>
            </div>

            {/* Theme */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Theme</label>
              <Select
                value={props.settings.theme}
                onChange={(e) => update("theme", e.currentTarget.value as DiffTheme)}
                compact
                class="w-full"
              >
                <For each={Object.entries(THEME_LABELS)}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </Select>
            </div>

            {/* Diff Mode */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Highlighting</label>
              <Select
                value={props.settings.lineDiffType}
                onChange={(e) => update("lineDiffType", e.currentTarget.value as LineDiffType)}
                compact
                class="w-full"
              >
                <For each={Object.entries(LINE_DIFF_LABELS)}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </Select>
            </div>

            {/* Accent */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Accent</label>
              <Select
                value={props.settings.accentColor}
                onChange={(e) => update("accentColor", e.currentTarget.value as AccentColor)}
                compact
                class="w-full"
              >
                <For each={Object.entries(ACCENT_LABELS)}>
                  {([value, label]) => (
                    <option
                      value={value}
                      style={{ color: ACCENT_THEME_VARS[value as AccentColor].dark.accent }}
                    >
                      {label}
                    </option>
                  )}
                </For>
              </Select>
            </div>

            {/* Font */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Font</label>
              <Select
                value={props.settings.fontFamily}
                onChange={(e) => update("fontFamily", e.currentTarget.value as FontFamily)}
                compact
                class="w-full"
                style={{
                  "font-family": FONT_FAMILY_MAP[props.settings.fontFamily],
                }}
              >
                <For each={Object.entries(FONT_LABELS)}>
                  {([value, label]) => (
                    <option
                      value={value}
                      style={{
                        "font-family": FONT_FAMILY_MAP[value as FontFamily],
                      }}
                    >
                      {label}
                    </option>
                  )}
                </For>
              </Select>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
