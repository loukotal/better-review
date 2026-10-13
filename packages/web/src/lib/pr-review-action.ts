/** A cache refresh failure must never turn a successful GitHub review into a failed submission. */
export async function submitPrReview<T>(
  submit: () => Promise<T>,
  refreshList: () => Promise<unknown>,
  onRefreshError: (error: unknown) => void = (error) =>
    console.error("PR list refresh failed:", error),
): Promise<T> {
  const result = await submit();
  try {
    await refreshList();
  } catch (error) {
    onRefreshError(error);
  }
  return result;
}
