import { createHash } from 'node:crypto';

/**
 * Computes the Minecraft "server hash" (the `serverId` value used by Mojang
 * `join` / `hasJoined`) exactly as the vanilla client does:
 *
 *   sha1( serverIdAscii || sharedSecretBytes || publicKeyDerBytes )
 *
 * then reinterpreted as a **signed** big-endian 160-bit integer, printed in
 * lowercase hex. Negative values keep a leading '-' and drop leading zeroes,
 * which is why this cannot just be `digest('hex')`.
 *
 * Reference behavior: Minecraft Java Edition `Encryption` / `MinecraftEncryption`.
 */
export function minecraftServerHash(
  serverId: string,
  sharedSecret: Buffer,
  publicKeyDer: Buffer,
): string {
  const digest = createHash('sha1')
    .update(serverId, 'ascii')
    .update(sharedSecret)
    .update(publicKeyDer)
    .digest();

  const unsigned = BigInt(`0x${digest.toString('hex')}`);
  const limit = 1n << 160n;
  const signed = unsigned >= limit / 2n ? unsigned - limit : unsigned;

  return signed.toString(16);
}
