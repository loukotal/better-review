export function resolveFileReference(reference: string, files: string[]): string | null {
  const explicitRelative = reference
    .trim()
    .replace(/^`|`$/g, "")
    .replaceAll("\\", "/")
    .startsWith("./");
  const normalized = reference
    .trim()
    .replace(/^`|`$/g, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (
    !normalized ||
    [...normalized].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null;
  if (normalized.split("/").some((part) => part === ".." || part === ".")) return null;

  const exact = files.find((file) => file === normalized);
  if (exact) return exact;

  // Absolute AI references may identify a known path, never a new source path.
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    const matches = files.filter((file) => normalized.endsWith(`/${file}`));
    return matches.length === 1 ? matches[0] : null;
  }
  if (normalized.includes(":")) return null;
  if (normalized.split("/").some((part) => !part)) return null;
  // An explicit repo-relative path is not basename shorthand.
  if (explicitRelative || normalized.includes("/")) return normalized;

  const basename = normalized.split("/").pop();
  const basenameMatches = files.filter((file) => file.split("/").pop() === basename);
  return basenameMatches.length === 1
    ? basenameMatches[0]
    : basenameMatches.length === 0
      ? normalized
      : null;
}
