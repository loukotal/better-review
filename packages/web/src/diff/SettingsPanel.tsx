import { createSignal, Show, For } from "solid-js";

import { GearIcon } from "../icons/gear-icon";
import {
  type DiffSettings,
  type DiffTheme,
  type LineDiffType,
  type FontFamily,
  FONT_FAMILY_MAP,
  FONT_LABELS,
  THEME_LABELS,
  LINE_DIFF_LABELS,
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
      <button
        type="button"
        onClick={() => setOpen(!open())}
        class="p-1.5 text-text-faint hover:text-accent transition-colors"
        title="Settings"
      >
        <GearIcon size={14} />
      </button>

      <Show when={open()}>
        {/* Backdrop */}
        <div class="fixed inset-0 z-40" onClick={() => setOpen(false)} />

        {/* Panel */}
        <div class="absolute top-full right-0 mt-1 z-50 w-[260px] border border-border bg-bg-surface shadow-lg shadow-black/50">
          {/* Panel Header */}
          <div class="px-3 py-2 border-b border-border flex items-center justify-between">
            <span class="text-sm text-text">Settings</span>
            <button
              onClick={() => setOpen(false)}
              class="text-text-faint hover:text-text text-base leading-none"
            >
              ×
            </button>
          </div>

          <div class="p-3 flex flex-col gap-3">
            {/* View Mode */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">View</label>
              <div class="flex">
                <button
                  type="button"
                  onClick={() => update("diffStyle", "split")}
                  class="flex-1 px-2 py-1.5 text-base border-y border-l border-border transition-colors"
                  classList={{
                    "bg-accent text-black border-accent": props.settings.diffStyle === "split",
                    "bg-bg text-text-muted hover:text-text": props.settings.diffStyle !== "split",
                  }}
                >
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => update("diffStyle", "unified")}
                  class="flex-1 px-2 py-1.5 text-base border border-border transition-colors"
                  classList={{
                    "bg-accent text-black border-accent": props.settings.diffStyle === "unified",
                    "bg-bg text-text-muted hover:text-text": props.settings.diffStyle !== "unified",
                  }}
                >
                  Unified
                </button>
              </div>
            </div>

            {/* Theme */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Theme</label>
              <select
                value={props.settings.theme}
                onChange={(e) => update("theme", e.currentTarget.value as DiffTheme)}
                class="px-2 py-1.5 bg-bg border border-border text-text text-sm focus:border-accent cursor-pointer"
              >
                <For each={Object.entries(THEME_LABELS)}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </select>
            </div>

            {/* Diff Mode */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Highlighting</label>
              <select
                value={props.settings.lineDiffType}
                onChange={(e) => update("lineDiffType", e.currentTarget.value as LineDiffType)}
                class="px-2 py-1.5 bg-bg border border-border text-text text-sm focus:border-accent cursor-pointer"
              >
                <For each={Object.entries(LINE_DIFF_LABELS)}>
                  {([value, label]) => <option value={value}>{label}</option>}
                </For>
              </select>
            </div>

            {/* Font */}
            <div class="flex flex-col gap-1.5">
              <label class="text-base text-text-faint">Font</label>
              <select
                value={props.settings.fontFamily}
                onChange={(e) => update("fontFamily", e.currentTarget.value as FontFamily)}
                class="px-2 py-1.5 bg-bg border border-border text-text text-sm focus:border-accent cursor-pointer"
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
              </select>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
