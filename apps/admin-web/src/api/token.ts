/** Current bearer token, kept in one place so the API client never imports the store. */
let currentToken: string | null = null;

export function setApiToken(token: string | null): void {
  currentToken = token;
}

export function getApiToken(): string | null {
  return currentToken;
}
