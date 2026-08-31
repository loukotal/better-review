import {
  ACCENT_LABELS,
  ACCENT_THEME_VARS,
  DEFAULT_DIFF_SETTINGS,
  THEME_LABELS,
  type AccentColor,
  type DiffSettings,
} from "../diff/types";
import type { UiTheme } from "./theme";

const SETTINGS_STORAGE_KEY = "diff-settings";
const VALID_THEMES = new Set(Object.keys(THEME_LABELS));
const VALID_ACCENTS = new Set(Object.keys(ACCENT_LABELS));
const ACCENT_CSS_VAR_MAP = {
  accent: "--color-accent",
  accentDim: "--color-accent-dim",
  accentBright: "--color-accent-bright",
  accentText: "--color-accent-text",
  borderFocus: "--color-border-focus",
  primary: "--color-primary",
  primaryHover: "--color-primary-hover",
  primaryText: "--color-primary-text",
} as const;

export function loadDiffSettings(): DiffSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.theme && !VALID_THEMES.has(parsed.theme)) {
        parsed.theme = DEFAULT_DIFF_SETTINGS.theme;
      }
      if (parsed.accentColor && !VALID_ACCENTS.has(parsed.accentColor)) {
        parsed.accentColor = DEFAULT_DIFF_SETTINGS.accentColor;
      }
      return { ...DEFAULT_DIFF_SETTINGS, ...parsed };
    }
  } catch {
    // Ignore storage and parse errors.
  }

  return DEFAULT_DIFF_SETTINGS;
}

export function saveDiffSettings(settings: DiffSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors.
  }
}

export function applyDiffAccent(accentColor: AccentColor, theme: UiTheme): void {
  const accentVars = ACCENT_THEME_VARS[accentColor][theme];
  for (const [key, cssVar] of Object.entries(ACCENT_CSS_VAR_MAP)) {
    document.documentElement.style.setProperty(cssVar, accentVars[key as keyof typeof accentVars]);
  }
}
