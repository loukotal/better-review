export interface PrLoadError {
  title: string;
  message: string;
}

const stripInternalStack = (message: string): string =>
  message
    .replace(/^\(FiberFailure\)\s*/, "")
    .replace(/^GhError:\s*/, "")
    .replace(/\s+at (?:<anonymous>|[A-Za-z_$][\w$.[\]<>]*\s*\(|\/Users\/|file:)[\s\S]*$/, "")
    .trim();

const sentenceCase = (message: string): string =>
  message.length === 0 ? message : message.charAt(0).toUpperCase() + message.slice(1);

export function describePrLoadError(error: unknown): PrLoadError {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = rawMessage.toLowerCase();

  if (
    lowerMessage.includes("http 503") ||
    lowerMessage.includes("no server is currently available")
  ) {
    return {
      title: "GitHub is temporarily unavailable",
      message: "GitHub returned HTTP 503. Try opening this pull request again in a few minutes.",
    };
  }

  if (
    lowerMessage.includes("failed to connect") ||
    lowerMessage.includes("could not resolve host") ||
    lowerMessage.includes("network")
  ) {
    return {
      title: "Couldn’t reach GitHub",
      message: "Check your connection, then try opening this pull request again.",
    };
  }

  if (
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("http 401") ||
    lowerMessage.includes("authentication")
  ) {
    return {
      title: "GitHub authentication failed",
      message: "Check your GitHub CLI login, then try opening this pull request again.",
    };
  }

  if (lowerMessage.includes("not found") || lowerMessage.includes("http 404")) {
    return {
      title: "Pull request not found",
      message: "Check the pull request URL and your repository access, then try again.",
    };
  }

  const cleanMessage = stripInternalStack(rawMessage).replace(/[.!?]+$/, "");
  const usefulMessage =
    cleanMessage.length > 0 ? sentenceCase(cleanMessage) : "GitHub returned an error";

  return {
    title: "Couldn’t open this pull request",
    message: `${usefulMessage}. Check the URL and try again.`,
  };
}
