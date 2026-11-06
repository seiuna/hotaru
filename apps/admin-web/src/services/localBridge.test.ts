import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, loginViaLocalBridge, probeLocalBridge } from './localBridge';

const TOKEN_BODY = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  tokenType: 'Bearer',
  expiresIn: 900,
  profile: { uuid: '4c1099df-e202-4e64-9ea2-9039be420143', username: 'yuuiyi' },
  scopes: ['skymatrix:profile', 'admin:users'],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeLocalBridge', () => {
  it('is true when the mod answers /v1/health', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }));
    await expect(probeLocalBridge()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/v1/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('is false when the port is closed', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(probeLocalBridge()).resolves.toBe(false);
  });

  it('is false when something else answers with a different service name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'other' }));
    await expect(probeLocalBridge()).resolves.toBe(false);
  });
});

describe('loginViaLocalBridge', () => {
  it('returns the token pair after approval', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }))
      .mockResolvedValueOnce(jsonResponse(200, TOKEN_BODY));

    const token = await loginViaLocalBridge();
    expect(token.accessToken).toBe('access-1');
    expect(token.profile.username).toBe('yuuiyi');
    expect(token.scopes).toContain('admin:users');
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8765/v1/login',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports "unavailable" when no bridge is listening', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(loginViaLocalBridge()).rejects.toMatchObject({
      name: 'BridgeError',
      kind: 'unavailable',
    });
  });

  it('reports "blocked" when the origin is not allowlisted', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { code: 'ORIGIN_NOT_ALLOWED' } }));

    const error = await loginViaLocalBridge().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).kind).toBe('blocked');
    expect((error as BridgeError).message).toContain('允许来源');
  });

  it('reports "denied" when the player refuses in game', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { code: 'APPROVAL_DENIED' } }));

    await expect(loginViaLocalBridge()).rejects.toMatchObject({ kind: 'denied' });
  });

  it('reports "timeout" when the approval window closes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }))
      .mockResolvedValueOnce(jsonResponse(408, { error: { code: 'APPROVAL_TIMEOUT' } }));

    await expect(loginViaLocalBridge()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects a malformed token payload instead of storing it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, service: 'skymatrix-local-auth' }))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'only-access' }));

    await expect(loginViaLocalBridge()).rejects.toMatchObject({ kind: 'failed', code: 'INVALID_RESPONSE' });
  });
});
