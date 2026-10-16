interface HighlightOptions {
  lang: string;
  theme: string;
}

type Highlighter = (code: string, options: HighlightOptions) => Promise<string>;

interface CacheOptions {
  maxEntries: number;
  maxBytes: number;
}

const languageAliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  dockerfile: "docker",
};

/** Cache successful highlights only; pending requests are shared within a generation. */
export function createHighlightCache(highlighter: Highlighter, options: CacheOptions) {
  const entries = new Map<string, { html: string; bytes: number }>();
  const pending = new Map<string, Promise<string>>();
  const encoder = new TextEncoder();
  let bytes = 0;
  let generation = 0;

  function highlight(code: string, lang: string, theme: string): Promise<string> {
    const language = lang.toLowerCase().trim();
    const normalizedLang = Object.hasOwn(languageAliases, language)
      ? (languageAliases[language] ?? language)
      : language;
    // Tuple encoding avoids collisions when code or language contains delimiters.
    const key = JSON.stringify([normalizedLang, theme, code]);
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
      return Promise.resolve(cached.html);
    }
    const existing = pending.get(key);
    if (existing !== undefined) return existing;

    const requestGeneration = generation;
    // Defer invocation so even synchronous throws settle through the pending promise.
    const request = Promise.resolve()
      .then(() => highlighter(code, { lang: normalizedLang, theme }))
      .then((html) => {
        if (requestGeneration !== generation) return html;
        const entryBytes = encoder.encode(key).byteLength + encoder.encode(html).byteLength;
        if (options.maxEntries < 1 || entryBytes > options.maxBytes) return html;

        while (entries.size >= options.maxEntries || bytes + entryBytes > options.maxBytes) {
          const oldest = entries.entries().next().value;
          if (!oldest) break;
          entries.delete(oldest[0]);
          bytes -= oldest[1].bytes;
        }
        entries.set(key, { html, bytes: entryBytes });
        bytes += entryBytes;
        return html;
      })
      .finally(() => {
        // An old completion must not remove a newer request created after clear().
        if (pending.get(key) === request) pending.delete(key);
      });
    pending.set(key, request);
    return request;
  }

  function clear(): void {
    generation += 1;
    entries.clear();
    pending.clear();
    bytes = 0;
  }

  return { highlight, clear };
}
