// ============ Settings Types ============

export type DiffStyle = "unified" | "split";
export type DiffTheme = "github-dark" | "github-light" | "pierre-dark" | "pierre-light";
export type LineDiffType = "word-alt" | "word" | "char" | "none";
export type FontFamily = "berkeley-mono" | "jetbrains-mono" | "fira-code" | "sf-mono" | "cascadia" | "consolas" | "monaco" | "system";

export interface DiffSettings {
  diffStyle: DiffStyle;
  theme: DiffTheme;
  lineDiffType: LineDiffType;
  fontFamily: FontFamily;
}

export const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  diffStyle: "split",
  theme: "github-dark",
  lineDiffType: "word",
  fontFamily: "system",
};

// ============ Font Configuration ============

export const FONT_FAMILY_MAP: Record<FontFamily, string> = {
  "berkeley-mono": "'Berkeley Mono', monospace",
  "jetbrains-mono": "'JetBrains Mono', monospace",
  "fira-code": "'Fira Code', monospace",
  "sf-mono": "'SF Mono', monospace",
  "cascadia": "'Cascadia Code', monospace",
  "consolas": "'Consolas', monospace",
  "monaco": "'Monaco', monospace",
  "system": "monospace",
};

export const FONT_LABELS: Record<FontFamily, string> = {
  "berkeley-mono": "Berkeley Mono",
  "jetbrains-mono": "JetBrains Mono",
  "fira-code": "Fira Code",
  "sf-mono": "SF Mono",
  "cascadia": "Cascadia Code",
  "consolas": "Consolas",
  "monaco": "Monaco",
  "system": "System Default",
};

// ============ Theme Configuration ============

export const THEME_LABELS: Record<DiffTheme, string> = {
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "pierre-dark": "Pierre Dark",
  "pierre-light": "Pierre Light",
};

// ============ Line Diff Configuration ============

export const LINE_DIFF_LABELS: Record<LineDiffType, string> = {
  "word-alt": "Word (Smart)",
  "word": "Word",
  "char": "Character",
  "none": "None",
};

// ============ Comment Types ============

export interface PRComment {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
}

export type AnnotationMetadata = 
  | { type: "comment"; comment: PRComment }
  | { type: "pending"; line: number; side: "LEFT" | "RIGHT" };
