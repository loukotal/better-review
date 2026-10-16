/** GitHub admission completes the action; list refresh runs independently afterward. */
export async function submitPrReview<T>(
  submit: () => Promise<T>,
  refreshList: () => Promise<unknown>,
  onRefreshError: (error: unknown) => void = (error) =>
    console.error("PR list refresh failed:", error),
): Promise<T> {
  const result = await submit();
  void Promise.resolve().then(refreshList).catch(onRefreshError);
  return result;
}
