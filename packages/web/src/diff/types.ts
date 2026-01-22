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

export interface DiffSettings {
  diffStyle: DiffStyle;
  theme: DiffTheme;
  lineDiffType: LineDiffType;
  fontFamily: FontFamily;
}

export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  diffStyle: "split",
  theme: "vesper",
  lineDiffType: "word",
  fontFamily: "system",
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
  | { type: "pending"; startLine: number; endLine: number; side: "LEFT" | "RIGHT" }
  | {
      type: "pending-reply";
      rootCommentId: number;
      line: number | null;
      side: "LEFT" | "RIGHT";
    }
  | { type: "ai-annotation"; annotation: Annotation };

// ============ Review Mode Types ============

export type ReviewMode = "full" | "commit";
