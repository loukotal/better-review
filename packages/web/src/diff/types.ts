import type { PRComment, PrCommit } from "@better-review/shared";

// Re-export shared types for convenience
export type { PRComment, PrCommit };

// ============ Settings Types ============

export type DiffStyle = "unified" | "split";
export type DiffTheme =
  | "vesper"
  | "github-dark"
  | "github-light"
  | "pierre-dark"
  | "pierre-light"
  | "tokyo-night"
  | "dracula"
  | "catppuccin-mocha"
  | "nord"
  | "rose-pine";
export type LineDiffType = "word-alt" | "word" | "char" | "none";
export type FontFamily =
  | "berkeley-mono"
  | "jetbrains-mono"
  | "fira-code"
  | "sf-mono"
  | "cascadia"
  | "consolas"
  | "monaco"
  | "system";
export type AccentColor = "orange" | "blue" | "purple" | "green" | "pink" | "red";

export interface DiffSettings {
  diffStyle: DiffStyle;
  theme: DiffTheme;
  lineDiffType: LineDiffType;
  fontFamily: FontFamily;
  accentColor: AccentColor;
}

export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  diffStyle: "split",
  theme: "vesper",
  lineDiffType: "word",
  fontFamily: "system",
  accentColor: "orange",
};

// ============ Font Configuration ============

export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  "berkeley-mono": "'Berkeley Mono', monospace",
  "jetbrains-mono": "'JetBrains Mono', monospace",
  "fira-code": "'Fira Code', monospace",
  "sf-mono": "'SF Mono', monospace",
  cascadia: "'Cascadia Code', monospace",
  consolas: "'Consolas', monospace",
  monaco: "'Monaco', monospace",
  system: "monospace",
};

export const FONT_LABELS: Record<FontFamily, string> = {
  "berkeley-mono": "Berkeley Mono",
  "jetbrains-mono": "JetBrains Mono",
  "fira-code": "Fira Code",
  "sf-mono": "SF Mono",
  cascadia: "Cascadia Code",
  consolas: "Consolas",
  monaco: "Monaco",
  system: "System Default",
};

// ============ Accent Configuration ============

export const ACCENT_LABELS: Record<AccentColor, string> = {
  orange: "Orange",
  blue: "Blue",
  purple: "Purple",
  green: "Green",
  pink: "Pink",
  red: "Red",
};

export interface AccentThemeVars {
  accent: string;
  accentDim: string;
  accentBright: string;
  accentText: string;
  borderFocus: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
}

export const ACCENT_THEME_VARS: Record<
  AccentColor,
  { dark: AccentThemeVars; light: AccentThemeVars }
> = {
  orange: {
    dark: {
      accent: "#ff6b00",
      accentDim: "#662b00",
      accentBright: "#ff8533",
      accentText: "#0a0a0a",
      borderFocus: "#ff6b00",
      primary: "#c75100",
      primaryHover: "#dd620f",
      primaryText: "#fff7ed",
    },
    light: {
      accent: "#c2410c",
      accentDim: "#ffedd5",
      accentBright: "#9a3412",
      accentText: "#fff7ed",
      borderFocus: "#c2410c",
      primary: "#c2410c",
      primaryHover: "#9a3412",
      primaryText: "#fff7ed",
    },
  },
  blue: {
    dark: {
      accent: "#38bdf8",
      accentDim: "#0c4a6e",
      accentBright: "#7dd3fc",
      accentText: "#082f49",
      borderFocus: "#38bdf8",
      primary: "#0284c7",
      primaryHover: "#0ea5e9",
      primaryText: "#f0f9ff",
    },
    light: {
      accent: "#0369a1",
      accentDim: "#e0f2fe",
      accentBright: "#075985",
      accentText: "#f0f9ff",
      borderFocus: "#0369a1",
      primary: "#0369a1",
      primaryHover: "#075985",
      primaryText: "#f0f9ff",
    },
  },
  purple: {
    dark: {
      accent: "#a78bfa",
      accentDim: "#4c1d95",
      accentBright: "#c4b5fd",
      accentText: "#1e1b4b",
      borderFocus: "#a78bfa",
      primary: "#7c3aed",
      primaryHover: "#8b5cf6",
      primaryText: "#f5f3ff",
    },
    light: {
      accent: "#7c3aed",
      accentDim: "#ede9fe",
      accentBright: "#6d28d9",
      accentText: "#f5f3ff",
      borderFocus: "#7c3aed",
      primary: "#7c3aed",
      primaryHover: "#6d28d9",
      primaryText: "#f5f3ff",
    },
  },
  green: {
    dark: {
      accent: "#22c55e",
      accentDim: "#14532d",
      accentBright: "#4ade80",
      accentText: "#052e16",
      borderFocus: "#22c55e",
      primary: "#16a34a",
      primaryHover: "#22c55e",
      primaryText: "#f0fdf4",
    },
    light: {
      accent: "#15803d",
      accentDim: "#dcfce7",
      accentBright: "#166534",
      accentText: "#f0fdf4",
      borderFocus: "#15803d",
      primary: "#15803d",
      primaryHover: "#166534",
      primaryText: "#f0fdf4",
    },
  },
  pink: {
    dark: {
      accent: "#f472b6",
      accentDim: "#831843",
      accentBright: "#f9a8d4",
      accentText: "#500724",
      borderFocus: "#f472b6",
      primary: "#db2777",
      primaryHover: "#ec4899",
      primaryText: "#fdf2f8",
    },
    light: {
      accent: "#be185d",
      accentDim: "#fce7f3",
      accentBright: "#9d174d",
      accentText: "#fdf2f8",
      borderFocus: "#be185d",
      primary: "#be185d",
      primaryHover: "#9d174d",
      primaryText: "#fdf2f8",
    },
  },
  red: {
    dark: {
      accent: "#f87171",
      accentDim: "#7f1d1d",
      accentBright: "#fca5a5",
      accentText: "#450a0a",
      borderFocus: "#f87171",
      primary: "#dc2626",
      primaryHover: "#ef4444",
      primaryText: "#fef2f2",
    },
    light: {
      accent: "#b91c1c",
      accentDim: "#fee2e2",
      accentBright: "#991b1b",
      accentText: "#fef2f2",
      borderFocus: "#b91c1c",
      primary: "#b91c1c",
      primaryHover: "#991b1b",
      primaryText: "#fef2f2",
    },
  },
};

// ============ Theme Configuration ============

export const THEME_LABELS: Record<DiffTheme, string> = {
  vesper: "Vesper",
  "tokyo-night": "Tokyo Night",
  dracula: "Dracula",
  "catppuccin-mocha": "Catppuccin Mocha",
  nord: "Nord",
  "rose-pine": "Rosé Pine",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "pierre-dark": "Pierre Dark",
  "pierre-light": "Pierre Light",
};

// Selection colors - using theme accent colors with transparency for better visibility
export const THEME_SELECTION_COLORS: Record<DiffTheme, string> = {
  vesper: "#ffc79940", // vesper orange/gold accent
  "tokyo-night": "#7aa2f766", // tokyo-night blue accent
  dracula: "#bd93f966", // dracula purple accent
  "catppuccin-mocha": "#cba6f766", // catppuccin mauve accent
  nord: "#88c0d066", // nord frost cyan
  "rose-pine": "#c4a7e766", // rose-pine iris
  "github-dark": "#58a6ff55", // github blue accent
  "github-light": "#0969da40", // github blue accent (light)
  "pierre-dark": "#009fff50", // pierre blue accent
  "pierre-light": "#009fff40", // pierre blue accent
};

// ============ Line Diff Configuration ============

export const LINE_DIFF_LABELS: Record<LineDiffType, string> = {
  "word-alt": "Word (Smart)",
  word: "Word",
  char: "Character",
  none: "None",
};

// ============ Annotation Metadata Types ============

import type { Annotation } from "../utils/parseReviewTokens";

export type AnnotationMetadata =
  | { type: "thread"; rootComment: PRComment; replies: PRComment[] }
  | {
      type: "pending";
      startLine: number;
      endLine: number;
      side: "LEFT" | "RIGHT";
      initialBody?: string;
    }
  | {
      type: "pending-reply";
      rootCommentId: number;
      line: number | null;
      side: "LEFT" | "RIGHT";
    }
  | { type: "ai-annotation"; annotation: Annotation };

// ============ Review Mode Types ============

export type ReviewMode = "full" | "commit";
