import { For, Show, type JSX } from "solid-js";

import { Field, Popover, Select, SegmentedControl } from "../design-system";
import { GearIcon } from "../icons/gear-icon";
import {
  type DiffSettings,
  type DiffTheme,
  type LineDiffType,
  type FontFamily,
  type AccentColor,
  FONT_LABELS,
  THEME_LABELS,
  LINE_DIFF_LABELS,
  ACCENT_LABELS,
} from "./types";
interface SettingsPanelProps {
  children?: JSX.Element;
  settings: DiffSettings;
  onChange: (settings: DiffSettings) => void;
}
export function SettingsPanel(props: SettingsPanelProps) {
  const update = <K extends keyof DiffSettings>(key: K, value: DiffSettings[K]) =>
    props.onChange({ ...props.settings, [key]: value });
  return (
    <Popover label="Diff settings" trigger={<GearIcon size={16} />}>
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-text-muted">Layout</span>
          <SegmentedControl
            label="Diff layout"
            value={props.settings.diffStyle}
            onChange={(value) => update("diffStyle", value)}
            options={[
              { value: "split", label: "Split" },
              { value: "unified", label: "Unified" },
            ]}
          />
        </div>
        <Field label="Code theme">
          {(id) => (
            <Select
              id={id}
              compact
              value={props.settings.theme}
              onChange={(e) => update("theme", e.currentTarget.value as DiffTheme)}
            >
              <For each={Object.entries(THEME_LABELS)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </Select>
          )}
        </Field>
        <Field label="Change highlighting">
          {(id) => (
            <Select
              id={id}
              compact
              value={props.settings.lineDiffType}
              onChange={(e) => update("lineDiffType", e.currentTarget.value as LineDiffType)}
            >
              <For each={Object.entries(LINE_DIFF_LABELS)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </Select>
          )}
        </Field>
        <Field label="Diff accent">
          {(id) => (
            <Select
              id={id}
              compact
              value={props.settings.accentColor}
              onChange={(e) => update("accentColor", e.currentTarget.value as AccentColor)}
            >
              <For each={Object.entries(ACCENT_LABELS)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </Select>
          )}
        </Field>
        <Field label="Code font">
          {(id) => (
            <Select
              id={id}
              compact
              value={props.settings.fontFamily}
              onChange={(e) => update("fontFamily", e.currentTarget.value as FontFamily)}
            >
              <For each={Object.entries(FONT_LABELS)}>
                {([value, label]) => <option value={value}>{label}</option>}
              </For>
            </Select>
          )}
        </Field>
        <Show when={props.children}>
          <div class="border-t border-border pt-3">{props.children}</div>
        </Show>
      </div>
    </Popover>
  );
}
