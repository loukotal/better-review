import type { DiffTheme } from "../diff/types";
import { createHighlightCache } from "./highlight-cache";

let shikiModulePromise: Promise<typeof import("shiki")> | undefined;

function loadShiki() {
  shikiModulePromise ??= import("shiki").catch((error: unknown) => {
    shikiModulePromise = undefined;
    throw error;
  });
  return shikiModulePromise;
}

const highlightCache = createHighlightCache(
  async (code, options) => {
    const { codeToHtml } = await loadShiki();
    return codeToHtml(code, options);
  },
  { maxEntries: 500, maxBytes: 8 * 1024 * 1024 },
);

/**
 * Map DiffTheme to shiki bundled theme names.
 * Pierre themes fallback to similar bundled themes for chat highlighting.
 */
function getShikiTheme(theme: DiffTheme): string {
  switch (theme) {
    // Direct mappings to bundled Shiki themes
    case "vesper":
    case "tokyo-night":
    case "dracula":
    case "catppuccin-mocha":
    case "nord":
    case "rose-pine":
    case "github-dark":
    case "github-light":
      return theme;
    // Pierre themes fallback to similar bundled themes
    case "pierre-dark":
      return "github-dark";
    case "pierre-light":
      return "github-light";
    default:
      return "github-dark";
  }
}

/**
 * Highlight code using Shiki.
 * Uses similar themes as the diff viewer for consistency.
 */
export async function highlightCode(code: string, lang: string, theme: DiffTheme): Promise<string> {
  const shikiTheme = getShikiTheme(theme);
  try {
    return await highlightCache.highlight(code, lang, shikiTheme);
  } catch (err) {
    console.warn("[shiki] Highlighting failed:", err);
    // Return escaped code as fallback
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Escape HTML entities for safe rendering
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Clear the highlight cache (useful when theme changes)
 */
export function clearHighlightCache(): void {
  highlightCache.clear();
}
