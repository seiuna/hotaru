import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose';
import { ServiceKeyModel } from '../mongo/models/index.js';
import type { AppConfig } from '../../config/env.js';

export interface JwtKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  kid: string;
  alg: 'EdDSA';
  publicJwk: JWK;
}

export interface MinecraftKeys {
  /** RSA private key used to decrypt shared secret + verify token. */
  privateKey: KeyObject;
  /** DER (SubjectPublicKeyInfo) bytes — these exact bytes are part of the hash. */
  publicKeyDer: Buffer;
  /** Base64 DER, what the challenge response hands to the client. */
  publicKeyBase64: string;
}

export interface ServiceKeys {
  jwt: JwtKeys;
  minecraft: MinecraftKeys;
}

const JWT_PURPOSE = 'jwt-ed25519';
const MC_PURPOSE = 'minecraft-rsa';

async function loadOrCreatePem(
  purpose: string,
  alg: string,
  generate: () => { privatePem: string; publicPem: string },
  config: AppConfig,
): Promise<{ privatePem: string; publicPem: string }> {
  const envOverride =
    purpose === JWT_PURPOSE
      ? { priv: config.jwtPrivateKeyPem, pub: config.jwtPublicKeyPem }
      : { priv: config.minecraftRsaPrivateKeyPem, pub: config.minecraftRsaPublicKeyPem };

  if (envOverride.priv && envOverride.pub) {
    return { privatePem: envOverride.priv, publicPem: envOverride.pub };
  }

  const existing = await ServiceKeyModel.findOne({ purpose }).lean();
  if (existing) {
    return { privatePem: existing.privatePem, publicPem: existing.publicPem };
  }

  const created = generate();
  try {
    await ServiceKeyModel.create({
      purpose,
      alg,
      kid: purpose,
      privatePem: created.privatePem,
      publicPem: created.publicPem,
    });
  } catch (error) {
    // Lost a race with another instance: read the winner's key instead.
    const winner = await ServiceKeyModel.findOne({ purpose }).lean();
    if (winner) return { privatePem: winner.privatePem, publicPem: winner.publicPem };
    throw error;
  }
  return created;
}

/**
 * Initialises both key pairs. Env PEMs take precedence; otherwise the pair is
 * generated once and stored in MongoDB so restarts and multiple instances agree
 * on JWKS and on the Minecraft public key.
 */
export async function initKeys(config: AppConfig): Promise<ServiceKeys> {
  const jwtPem = await loadOrCreatePem(
    JWT_PURPOSE,
    'EdDSA',
    () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      return {
        privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
    },
    config,
  );

  const jwtPrivateKey = createPrivateKey(jwtPem.privatePem);
  const jwtPublicKey = createPublicKey(jwtPem.publicPem);
  const publicJwk = await exportJWK(jwtPublicKey);
  const kid = await calculateJwkThumbprint(publicJwk, 'sha256');

  const mcPem = await loadOrCreatePem(
    MC_PURPOSE,
    'RSA-1024',
    () => {
      // 1024-bit RSA is what the vanilla client expects for this handshake.
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
      return {
        privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      };
    },
    config,
  );

  const mcPrivateKey = createPrivateKey(mcPem.privatePem);
  const mcPublicKey = createPublicKey(mcPem.publicPem);
  const spki = mcPublicKey.export({ type: 'spki', format: 'der' });

  return {
    jwt: {
      privateKey: jwtPrivateKey,
      publicKey: jwtPublicKey,
      kid,
      alg: 'EdDSA',
      publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'EdDSA' },
    },
    minecraft: {
      privateKey: mcPrivateKey,
      publicKeyDer: spki,
      publicKeyBase64: spki.toString('base64'),
    },
  };
}
