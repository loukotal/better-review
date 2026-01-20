import { codeToHtml } from "shiki";

import type { DiffTheme } from "../diff/types";

// Cache for highlighted code to avoid re-highlighting the same content
const highlightCache = new Map<string, string>();

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
  const cacheKey = `${shikiTheme}:${lang}:${code}`;
  const cached = highlightCache.get(cacheKey);
  if (cached) return cached;

  try {
    const normalizedLang = normalizeLanguage(lang);

    const html = await codeToHtml(code, {
      lang: normalizedLang,
      theme: shikiTheme,
    });

    // Cache the result (limit cache size to prevent memory issues)
    if (highlightCache.size > 500) {
      const firstKey = highlightCache.keys().next().value;
      if (firstKey) highlightCache.delete(firstKey);
    }
    highlightCache.set(cacheKey, html);

    return html;
  } catch (err) {
    console.warn("[shiki] Highlighting failed:", err);
    // Return escaped code as fallback
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Normalize language aliases to Shiki-supported language names
 */
function normalizeLanguage(lang: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    jsx: "jsx",
    tsx: "tsx",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    dockerfile: "docker",
  };

  const normalized = lang.toLowerCase().trim();
  return aliases[normalized] || normalized;
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
