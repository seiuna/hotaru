import { describe, expect, it } from 'vitest';
import { generateTotp, totpUri, verifyTotp } from './totp.js';

// RFC 6238 test key: ASCII "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vector at 59 seconds', () => {
    // RFC vector is 94287082 at 8 digits; our UI uses the standard 6 digits.
    expect(generateTotp(RFC_SECRET, 59_000)).toBe('287082');
  });

  it('accepts one period of clock skew and rejects unrelated codes', () => {
    expect(verifyTotp(RFC_SECRET, '287082', 59_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '287082', 89_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '287082', 149_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '000000', 59_000)).toBe(false);
  });

  it('builds an otpauth URI with issuer, algorithm and period', () => {
    const uri = totpUri('Hotaru', 'alice', RFC_SECRET);
    expect(uri).toContain('otpauth://totp/Hotaru%3Aalice');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=Hotaru');
    expect(uri).toContain('period=30');
  });
});
