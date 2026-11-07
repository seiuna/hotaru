import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { minecraftServerHash } from '../../infrastructure/crypto/server-hash.js';

interface Vector {
  name: string;
  serverId: string;
  sharedSecretHex: string;
  publicKeyDerHex: string;
  /** Pinned output, derived independently with BigInt.asIntN(160, sha1(...)). */
  expected: string;
}

const VECTORS: Vector[] = [
  {
    name: 'typical handshake',
    serverId: 'hotaru-server-1',
    sharedSecretHex: '000102030405060708090a0b0c0d0e0f',
    publicKeyDerHex: '30820122300d06092a864886f70d01010105000382010f00aabbccdd',
    expected: '5242a762d815426edae6d2bc2485f9413558453e',
  },
  {
    name: 'positive digest',
    serverId: 'notch',
    sharedSecretHex: 'ffffffffffffffffffffffffffffffff',
    publicKeyDerHex: 'deadbeef',
    expected: '3f696561943532a32eea2486f8342762318cc7df',
  },
  {
    name: 'empty server id',
    serverId: '',
    sharedSecretHex: '00112233445566778899aabbccddeeff',
    publicKeyDerHex: '30',
    expected: '-25d17b891a2a43771a09fde8a2cd7154febcfa71',
  },
];

/** Independent reference implementation of the vanilla algorithm. */
function referenceHash(serverId: string, sharedSecret: Buffer, publicKeyDer: Buffer): string {
  const digest = createHash('sha1')
    .update(serverId, 'ascii')
    .update(sharedSecret)
    .update(publicKeyDer)
    .digest();
  return BigInt.asIntN(160, BigInt(`0x${digest.toString('hex')}`)).toString(16);
}

describe('minecraftServerHash', () => {
  for (const vector of VECTORS) {
    it(`matches the pinned vector: ${vector.name}`, () => {
      const sharedSecret = Buffer.from(vector.sharedSecretHex, 'hex');
      const publicKeyDer = Buffer.from(vector.publicKeyDerHex, 'hex');

      const hash = minecraftServerHash(vector.serverId, sharedSecret, publicKeyDer);

      expect(hash).toBe(vector.expected);
      expect(hash).toBe(referenceHash(vector.serverId, sharedSecret, publicKeyDer));
    });
  }

  it('renders the sha1 digest as a signed 160-bit integer (leading "-" preserved)', () => {
    for (const vector of VECTORS) {
      const hash = minecraftServerHash(
        vector.serverId,
        Buffer.from(vector.sharedSecretHex, 'hex'),
        Buffer.from(vector.publicKeyDerHex, 'hex'),
      );
      const unsigned = hash.startsWith('-') ? hash.slice(1) : hash;
      expect(unsigned).toMatch(/^[0-9a-f]+$/);
      // No zero padding and no uppercase, exactly like the vanilla client.
      expect(unsigned.startsWith('0')).toBe(false);
    }
  });

  it('is deterministic and sensitive to every input', () => {
    const secret = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const der = Buffer.from('aabbccdd', 'hex');

    const base = minecraftServerHash('server', secret, der);
    expect(minecraftServerHash('server', secret, der)).toBe(base);

    expect(minecraftServerHash('server2', secret, der)).not.toBe(base);
    expect(minecraftServerHash('server', Buffer.from('000102030405060708090a0b0c0d0e00', 'hex'), der)).not.toBe(base);
    expect(minecraftServerHash('server', secret, Buffer.from('aabbccde', 'hex'))).not.toBe(base);
  });

  it('treats the server id as ASCII and hashes the exact DER bytes', () => {
    const secret = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const der = Buffer.from('deadbeefcafe', 'hex');

    const withDer = minecraftServerHash('abc', secret, der);
    const withoutDer = minecraftServerHash('abc', secret, Buffer.alloc(0));
    expect(withDer).not.toBe(withoutDer);
  });
});
