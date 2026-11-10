import { createSignal } from "solid-js";

export type UiDensity = "comfortable" | "compact";
export const UI_ZOOM_LEVELS = [100, 90, 80, 70] as const;
export type UiZoom = (typeof UI_ZOOM_LEVELS)[number];
export interface UiDisplaySettings {
  density: UiDensity;
  zoom: UiZoom;
}

export const UI_DISPLAY_SETTINGS_KEY = "better-review:ui-display:v1";
export const DEFAULT_UI_DISPLAY_SETTINGS: UiDisplaySettings = { density: "compact", zoom: 100 };
type DisplayStorage = Pick<Storage, "getItem" | "setItem">;

function isUiZoom(value: unknown): value is UiZoom {
  return UI_ZOOM_LEVELS.includes(value as UiZoom);
}

export function loadUiDisplaySettings(storage?: DisplayStorage): UiDisplaySettings {
  try {
    const value: unknown = JSON.parse(
      (storage ?? localStorage).getItem(UI_DISPLAY_SETTINGS_KEY) ?? "null",
    );
    if (!value || typeof value !== "object") return DEFAULT_UI_DISPLAY_SETTINGS;
    const stored = value as Partial<Record<keyof UiDisplaySettings, unknown>>;
    return {
      density: stored.density === "comfortable" ? "comfortable" : "compact",
      zoom: isUiZoom(stored.zoom) ? stored.zoom : DEFAULT_UI_DISPLAY_SETTINGS.zoom,
    };
  } catch {
    return DEFAULT_UI_DISPLAY_SETTINGS;
  }
}

export function saveUiDisplaySettings(settings: UiDisplaySettings, storage?: DisplayStorage): void {
  try {
    (storage ?? localStorage).setItem(UI_DISPLAY_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* Keep this session's choice when storage is unavailable. */
  }
}

/** Virtualizer estimate; must match --diffs-line-height in index.css. */
export function diffCodeMetrics(settings: UiDisplaySettings) {
  return {
    lineHeight: Math.round((settings.density === "compact" ? 18 : 20) * (settings.zoom / 100)),
  };
}

const [displaySignal, setDisplaySignal] = createSignal(loadUiDisplaySettings());
export const uiDisplay = displaySignal;

function applyUiDisplay(settings: UiDisplaySettings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.uiDensity = settings.density;
  root.style.setProperty("--ui-zoom", String(settings.zoom / 100));
}

export function initializeUiDisplay(): void {
  const settings = loadUiDisplaySettings();
  setDisplaySignal(settings);
  applyUiDisplay(settings);
}

export function setUiDisplay(patch: Partial<UiDisplaySettings>): void {
  const settings = { ...displaySignal(), ...patch };
  setDisplaySignal(settings);
  applyUiDisplay(settings);
  saveUiDisplaySettings(settings);
}
