import type { ChallengeRequest } from '@hotaru/api-contract';
import type { AppConfig } from '../../config/env.js';
import { Errors } from '../../errors.js';
import { normalizeClientPublicKey } from '../../infrastructure/crypto/client-key.js';

export interface ResolvedClient {
  id: string;
  version: string | null;
  keyId: string | null;
}

/**
 * Resolves the client identity attached to a challenge. When CLIENT_KEYS is
 * empty this stays backward compatible with the old `client: "fabric"` body;
 * when at least one key is configured, every client must send its registered
 * public key.
 */
export function resolveClientIdentity(
  config: AppConfig,
  client: ChallengeRequest['client'],
): ResolvedClient {
  if (typeof client === 'string') {
    if (Object.keys(config.clientKeys).length > 0) throw Errors.clientRequired();
    return { id: client, version: null, keyId: null };
  }

  if (Object.keys(config.clientKeys).length === 0) {
    return { id: client.id, version: client.version ?? null, keyId: null };
  }

  const approved = config.clientKeys[client.id];
  if (!approved) throw Errors.clientUnknown();
  const presented = normalizeClientPublicKey(client.publicKey);
  if (presented.publicKey !== approved.publicKey) throw Errors.clientKeyMismatch();

  return { id: client.id, version: client.version ?? null, keyId: approved.keyId };
}
