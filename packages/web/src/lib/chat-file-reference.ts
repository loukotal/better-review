/** Recognize source links, not external URLs or arbitrary inline identifiers. */
export function parseChatFileReference(
  value: string,
  files: string[],
  inlineCode = false,
): { file: string; line?: number } | null {
  if (/^[a-z][\w+.-]*:\/\//i.test(value) || /[<>"'\r\n]/.test(value)) return null;
  const match = value.trim().match(/^(.+?)(?:(?::|#L)(\d+)(?:(?:-|–|—)(?:L)?\d+)?)?$/);
  if (!match) return null;
  const [, file, lineText] = match;
  if (/^[a-z][\w+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return null;
  if (!/\.[a-z\d]+$/i.test(file) && !files.includes(file.replace(/^\.\//, ""))) return null;
  if (
    inlineCode &&
    !lineText &&
    !file.includes("/") &&
    !files.some((path) => path === file || path.endsWith(`/${file}`))
  )
    return null;
  const line = lineText ? Number(lineText) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  // Ambiguous basenames remain clickable: the handler reports ambiguity instead of silently guessing.
  return { file, ...(line !== undefined ? { line } : {}) };
}
