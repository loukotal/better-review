export interface PrLoadError {
  title: string;
  message: string;
}

const fallbackMessage = "An unexpected error occurred. Please try again.";

export function describePrLoadError(error: unknown): PrLoadError {
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";

  const githubUnavailable = /api\.github\.com|github is unavailable/i.test(message);

  return {
    title: githubUnavailable ? "GitHub is unavailable" : "Could not load pull request",
    message: message || fallbackMessage,
  };
}
