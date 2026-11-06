import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAYER_NAME,
  postChallenge,
  postVerify,
  purgeAuthCoreData,
  startHarness,
  stopHarness,
  stubMojang,
  type AuthCoreHarness,
  type InjectResponse,
} from './support/auth-core-harness.js';

/**
 * Dedicated harness with tiny windows/maxima so the limits can actually be hit:
 * 2 challenges and 2 verifies per window.
 */
let harness: AuthCoreHarness;

const IP_A = '198.51.100.10';
const IP_B = '198.51.100.11';
const forwarded = (ip: string): Record<string, string> => ({ 'x-forwarded-for': ip });

beforeAll(async () => {
  harness = await startHarness({
    RATE_LIMIT_CHALLENGE_MAX: '2',
    RATE_LIMIT_VERIFY_MAX: '2',
    RATE_LIMIT_WINDOW_SECONDS: '60',
  });
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

describe('challenge rate limiting', () => {
  it('throttles the third challenge from the same IP', async () => {
    const first = await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_A));
    const second = await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_A));
    const third = await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_A));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);

    const body = third.json();
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryable).toBe(true);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.headers['retry-after']).toBeDefined();

    // Neither counter leaks the username into a response body.
    expect(third.body).not.toContain(PLAYER_NAME);

    expect(await harness.redis.exists(`auth:rate:ip:${IP_A}`)).toBe(1);
    expect(await harness.redis.exists(`auth:rate:uuid:${PLAYER_NAME.toLowerCase()}`)).toBe(1);
  });

  it('limits per username independently of the source IP', async () => {
    await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_A));
    await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_A));

    // New IP, same username: the username counter is exhausted.
    const thirdFromOtherIp = await postChallenge(harness.app, PLAYER_NAME, forwarded(IP_B));
    expect(thirdFromOtherIp.statusCode).toBe(429);

    // A different username from the same IP is still allowed (IP counter is at 2/2).
    const otherUser = await postChallenge(harness.app, 'OtherPlayer', forwarded(IP_B));
    expect(otherUser.statusCode).toBe(200);
  });
});

describe('verify rate limiting', () => {
  it('throttles repeated verify attempts', async () => {
    stubMojang({ status: 204 });

    const attempt = (): Promise<InjectResponse> =>
      postVerify(harness.app, {
        challengeId: randomUUID(),
        username: PLAYER_NAME,
        encryptedSharedSecret: 'AAAA',
        encryptedVerifyToken: 'AAAA',
      });

    expect((await attempt()).statusCode).toBe(404);
    expect((await attempt()).statusCode).toBe(404);
    const throttled = await attempt();

    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().error.code).toBe('RATE_LIMITED');
  });
});
