export function resolveFileReference(reference: string, files: string[]): string | null {
  const normalized = reference
    .trim()
    .replace(/^`|`$/g, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
  if (!normalized) return null;

  const exact = files.find((file) => file === normalized);
  if (exact) return exact;

  const suffixMatches = files.filter(
    (file) => normalized.endsWith(`/${file}`) || file.endsWith(`/${normalized}`),
  );
  if (suffixMatches.length === 1) return suffixMatches[0];

  const basename = normalized.split("/").pop();
  const basenameMatches = files.filter((file) => file.split("/").pop() === basename);
  return basenameMatches.length === 1 ? basenameMatches[0] : null;
}
