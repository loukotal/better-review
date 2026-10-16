/** Dev proxies can return an empty/text error while the API process is restarting. */
export function checkApiResponse(response: Response): Response {
  if (!response.ok && !response.headers.get("content-type")?.includes("application/json")) {
    if ([502, 503, 504].includes(response.status)) {
      throw new Error(
        `The API is unavailable (HTTP ${response.status}). It may be restarting. Try again shortly.`,
      );
    }
    throw new Error(`API request failed (HTTP ${response.status}). Try again.`);
  }
  return response;
}
