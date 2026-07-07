// Pure secp256k1 keypair generation, signing, and did:key derivation.
// Browser-safe — zero Deno APIs. Uses @noble/curves (pure JS).

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";

const SECP256K1_MULTICODEC = new Uint8Array([0xe7, 0x01]);

// Base58btc encoder (Bitcoin alphabet)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58btcEncode(bytes: Uint8Array): string {
  let z = 0;
  while (z < bytes.length && bytes[z] === 0) z++;
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n = (n << 8n) | BigInt(bytes[i]);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n = n / 58n;
  }
  return "1".repeat(z) + s;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function compressPublicKey(uncompressed: Uint8Array): Uint8Array {
  const x = uncompressed.slice(1, 33);
  const y = uncompressed.slice(33, 65);
  const prefix = y[y.length - 1] % 2 === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(33);
  out[0] = prefix;
  out.set(x, 1);
  return out;
}

/** Derive a did:key from a raw (uncompressed) secp256k1 public key. */
export function didFromPublicKey(publicKey: Uint8Array): string {
  const compressed = compressPublicKey(publicKey);
  const prefixed = new Uint8Array(SECP256K1_MULTICODEC.length + compressed.length);
  prefixed.set(SECP256K1_MULTICODEC, 0);
  prefixed.set(compressed, SECP256K1_MULTICODEC.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

export interface MarketKeypair {
  did(): string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  exportHex(): string;
}

export class Secp256k1Keypair implements MarketKeypair {
  private constructor(private privateKey: Uint8Array, private publicKey: Uint8Array) {}

  static async create(): Promise<Secp256k1Keypair> {
    const priv = secp256k1.utils.randomPrivateKey();
    const pub = secp256k1.getPublicKey(priv, false);
    return new Secp256k1Keypair(priv, pub);
  }

  static import(privateKeyHex: string): Secp256k1Keypair {
    const priv = fromHex(privateKeyHex);
    const pub = secp256k1.getPublicKey(priv, false);
    return new Secp256k1Keypair(priv, pub);
  }

  did(): string {
    return didFromPublicKey(this.publicKey);
  }

  async sign(bytes: Uint8Array): Promise<Uint8Array> {
    const hash = sha256(bytes);
    const sig = secp256k1.sign(hash, this.privateKey, { lowS: true });
    return sig.toCompactRawBytes();
  }

  exportHex(): string {
    return toHex(this.privateKey);
  }

  /** Export the uncompressed public key as hex. */
  exportPublicKeyHex(): string {
    return toHex(this.publicKey);
  }
}

/** Convenience function: generate a keypair and return hex keys + did. */
export async function generateKeypair(): Promise<{
  privateKeyHex: string;
  publicKeyHex: string;
  did: string;
}> {
  const kp = await Secp256k1Keypair.create();
  return {
    privateKeyHex: kp.exportHex(),
    publicKeyHex: kp.exportPublicKeyHex(),
    did: kp.did(),
  };
}
