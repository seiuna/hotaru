/**
 * Decodes a JWT payload for UI purposes only (expiry countdown, display).
 * The signature is NEVER trusted here — the server verifies it on every call.
 */
export interface DecodedAccessToken {
  sub: string;
  sid: string;
  minecraft_uuid: string;
  scope: string;
  iss: string;
  aud: string[] | string;
  iat: number;
  exp: number;
  jti: string;
}

export function decodeToken(token: string): DecodedAccessToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed = JSON.parse(json) as Partial<DecodedAccessToken>;
    if (typeof parsed.exp !== 'number') return null;
    return {
      sub: String(parsed.sub ?? ''),
      sid: String(parsed.sid ?? ''),
      minecraft_uuid: String(parsed.minecraft_uuid ?? ''),
      scope: String(parsed.scope ?? ''),
      iss: String(parsed.iss ?? ''),
      aud: parsed.aud ?? [],
      iat: Number(parsed.iat ?? 0),
      exp: parsed.exp,
      jti: String(parsed.jti ?? ''),
    };
  } catch {
    return null;
  }
}

/** True when the token is missing an expiry or is already past it. */
export function isTokenExpired(token: string, now: number = Date.now()): boolean {
  const decoded = decodeToken(token);
  if (!decoded) return true;
  return decoded.exp * 1000 <= now;
}
