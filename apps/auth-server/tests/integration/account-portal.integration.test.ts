import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import type { PortalTokenResponse } from '@hotaru/api-contract';
import { MinecraftLinkModel } from '../../src/infrastructure/mongo/models/index.js';
import { signActivationCode } from '../../src/infrastructure/activation/code.js';
import {
  createVerifyBody,
  PLAYER_NAME,
  PLAYER_UUID,
  postVerify,
  purgeAuthCoreData,
  startHarness,
  stopHarness,
  stubMojangJoined,
  type AuthCoreHarness,
} from './support/auth-core-harness.js';

const SECOND_UUID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_NAME = 'hotaru_user';
const PASSWORD = 'correct horse battery staple';

let harness: AuthCoreHarness;
let privateKeyPem: string;

async function portalCall(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  token?: string,
) {
  return harness.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as Record<string, unknown> | undefined,
  });
}

async function activate(code: string): Promise<void> {
  const response = await portalCall('POST', '/api/v1/portal/activate', {
    code,
    username: ACCOUNT_NAME,
    password: PASSWORD,
  });
  expect(response.statusCode).toBe(201);
}

async function login(): Promise<PortalTokenResponse> {
  const response = await portalCall('POST', '/api/v1/portal/login', {
    username: ACCOUNT_NAME,
    password: PASSWORD,
  });
  expect(response.statusCode).toBe(200);
  return response.json<PortalTokenResponse>();
}

function accountCode(expSeconds = 600): string {
  return signActivationCode(
    { v: 1, type: 'account', jti: randomUUID(), exp: Math.floor(Date.now() / 1000) + expSeconds },
    privateKeyPem,
  );
}

function bindCode(uuid: string, username: string, expSeconds = 600): string {
  return signActivationCode(
    {
      v: 1,
      type: 'bind',
      jti: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + expSeconds,
      uuid,
      username,
    },
    privateKeyPem,
  );
}

beforeAll(async () => {
  const keys = generateKeyPairSync('ed25519');
  privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  harness = await startHarness({ ACTIVATION_PUBLIC_KEY_PEM: publicKeyPem });
});

beforeEach(async () => {
  await purgeAuthCoreData(harness.redis);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await stopHarness(harness);
});

describe('user portal account flow', () => {
  it('activates an account and rejects code reuse', async () => {
    const code = accountCode();
    await activate(code);

    const second = await portalCall('POST', '/api/v1/portal/activate', {
      code,
      username: 'another_user',
      password: PASSWORD,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ACTIVATION_USED');
  });

  it('logs in with a portal token that cannot call the game API or carry a UUID', async () => {
    await activate(accountCode());
    const tokens = await login();

    const { payload } = await jwtVerify(tokens.accessToken, harness.ctx.keys.jwt.publicKey, {
      issuer: harness.config.jwtIssuer,
      audience: harness.config.portalJwtAudience,
      algorithms: ['EdDSA'],
    });
    expect(payload.aud).toEqual([harness.config.portalJwtAudience]);
    expect(payload.minecraft_uuid).toBeUndefined();
    expect(payload.scope).toContain('portal:account');

    const me = await portalCall('GET', '/api/v1/portal/me', undefined, tokens.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().account.loginName).toBe(ACCOUNT_NAME);

    const gameApi = await portalCall('GET', '/api/v1/users/me', undefined, tokens.accessToken);
    expect(gameApi.statusCode).toBe(401);
  });

  it('binds a game-issued code and lets the linked MC account inherit account scopes', async () => {
    await activate(accountCode());
    const portal = await login();

    stubMojangJoined();
    const first = await createVerifyBody(harness.app, PLAYER_NAME);
    const linkRequired = await postVerify(harness.app, first.body);
    expect(linkRequired.statusCode).toBe(403);
    const details = linkRequired.json().error.details as {
      bindingCode: string;
      expiresIn: number;
    };
    expect(details.bindingCode).toMatch(/^HOTARU-/);

    const bind = await portalCall(
      'POST',
      '/api/v1/portal/bind',
      { code: details.bindingCode },
      portal.accessToken,
    );
    expect(bind.statusCode).toBe(200);
    expect(bind.json().account.links).toHaveLength(1);

    const second = await createVerifyBody(harness.app, PLAYER_NAME);
    const verify = await postVerify(harness.app, second.body);
    expect(verify.statusCode).toBe(200);
    const tokens = verify.json();
    expect(tokens.profile.uuid).toBe(PLAYER_UUID);
    expect(tokens.scopes.sort()).toEqual(['hotaru:profile', 'hotaru:resource']);
  });

  it('accepts a signed bind code, and unbinding removes the link', async () => {
    await activate(accountCode());
    const portal = await login();

    const bind = await portalCall(
      'POST',
      '/api/v1/portal/bind',
      { code: bindCode(SECOND_UUID, 'SecondPlayer') },
      portal.accessToken,
    );
    expect(bind.statusCode).toBe(200);
    expect(bind.json().account.links[0].uuid).toBe(SECOND_UUID);

    const unbind = await portalCall(
      'POST',
      '/api/v1/portal/unbind',
      { uuid: SECOND_UUID },
      portal.accessToken,
    );
    expect(unbind.statusCode).toBe(200);
    expect(unbind.json().account.links).toHaveLength(0);
  });

  it('rejects a banned UUID while keeping the portal account usable', async () => {
    await activate(accountCode());
    const portal = await login();
    const bind = await portalCall(
      'POST',
      '/api/v1/portal/bind',
      { code: bindCode(SECOND_UUID, 'SecondPlayer') },
      portal.accessToken,
    );
    expect(bind.statusCode).toBe(200);
    await MinecraftLinkModel.updateOne(
      { minecraftUuid: SECOND_UUID },
      { $set: { status: 'banned' } },
    );

    stubMojangJoined({ id: SECOND_UUID.replace(/-/g, ''), name: 'SecondPlayer' });
    const challenge = await createVerifyBody(harness.app, 'SecondPlayer');
    const verify = await postVerify(harness.app, challenge.body);
    expect(verify.statusCode).toBe(403);
    expect(verify.json().error.code).toBe('UUID_BANNED');

    const me = await portalCall('GET', '/api/v1/portal/me', undefined, portal.accessToken);
    expect(me.statusCode).toBe(200);
  });

  it('changes the password and invalidates the old password', async () => {
    await activate(accountCode());
    const portal = await login();

    const change = await portalCall(
      'POST',
      '/api/v1/portal/password',
      { currentPassword: PASSWORD, newPassword: 'new correct horse battery staple' },
      portal.accessToken,
    );
    expect(change.statusCode).toBe(204);

    const oldLogin = await portalCall('POST', '/api/v1/portal/login', {
      username: ACCOUNT_NAME,
      password: PASSWORD,
    });
    expect(oldLogin.statusCode).toBe(401);
    expect(oldLogin.json().error.code).toBe('INVALID_CREDENTIALS');

    const newLogin = await portalCall('POST', '/api/v1/portal/login', {
      username: ACCOUNT_NAME,
      password: 'new correct horse battery staple',
    });
    expect(newLogin.statusCode).toBe(200);
  });
});
