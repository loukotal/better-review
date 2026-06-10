import { createSignal } from "solid-js";

export type UiTheme = "dark" | "light";

const UI_THEME_STORAGE_KEY = "better-review-ui-theme";

function isUiTheme(value: string | null): value is UiTheme {
  return value === "dark" || value === "light";
}

function getPreferredUiTheme(): UiTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function getStoredUiTheme(): UiTheme | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const stored = localStorage.getItem(UI_THEME_STORAGE_KEY);
    return isUiTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

function resolveInitialUiTheme(): UiTheme {
  return getStoredUiTheme() ?? getPreferredUiTheme();
}

const [uiThemeSignal, setUiThemeSignal] = createSignal<UiTheme>(resolveInitialUiTheme());

export const uiTheme = uiThemeSignal;

function applyUiTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;

  document.documentElement.dataset.uiTheme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function initializeUiTheme(): void {
  const theme = resolveInitialUiTheme();
  setUiThemeSignal(theme);
  applyUiTheme(theme);
}

export function setUiTheme(theme: UiTheme): void {
  setUiThemeSignal(theme);
  applyUiTheme(theme);

  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage errors; the active document theme has still been applied.
  }
}

export function toggleUiTheme(): void {
  setUiTheme(uiThemeSignal() === "dark" ? "light" : "dark");
}
