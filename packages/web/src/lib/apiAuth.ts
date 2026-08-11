const STORAGE_KEY = "better-review.apiToken";
const COOKIE_NAME = "better_review_api_token";
const CLIENT_ID_STORAGE_KEY = "better-review.clientId";

function envToken(): string {
  return (import.meta.env?.VITE_BETTER_REVIEW_API_TOKEN ?? "").trim();
}

function setApiAuthCookie(token: string): void {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api; SameSite=Strict`;
}

function clearApiAuthCookie(): void {
  document.cookie = `${COOKIE_NAME}=; Path=/api; SameSite=Strict; Max-Age=0`;
}

export function getApiToken(): string {
  const token = envToken() || localStorage.getItem(STORAGE_KEY)?.trim() || "";
  if (token) {
    setApiAuthCookie(token);
  } else {
    clearApiAuthCookie();
  }
  return token;
}

export function clearStoredApiToken(): void {
  localStorage.removeItem(STORAGE_KEY);
  clearApiAuthCookie();
}

export function promptForApiToken(): string {
  const token = window.prompt("Enter BETTER_REVIEW_API_TOKEN")?.trim() ?? "";
  if (token) {
    localStorage.setItem(STORAGE_KEY, token);
    setApiAuthCookie(token);
  }
  return token;
}

export function getApiAuthHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getApiAuthConnectionParams(): Record<string, string> {
  const token = getApiToken();
  const clientId = getApiClientId();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    clientId,
  };
}

export function getApiClientId(): string {
  let clientId = sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
  if (!clientId) {
    clientId = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
  }
  return clientId;
}

export async function fetchWithApiAuth(input: RequestInfo | URL, init: RequestInit = {}) {
  const withHeaders = (tokenHeaders: Record<string, string>): RequestInit => ({
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      ...tokenHeaders,
    },
  });

  let response = await fetch(input, withHeaders(getApiAuthHeaders()));
  if (response.status !== 401 || envToken()) {
    return response;
  }

  clearStoredApiToken();
  const token = promptForApiToken();
  if (!token) return response;

  response = await fetch(input, withHeaders(getApiAuthHeaders()));
  return response;
}
