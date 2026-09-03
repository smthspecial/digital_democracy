// Test-only client-side implementations matching auth-service's real MFA
// proof algorithms (services/go/auth-service/crypto.go) so the e2e suite can
// drive real POST /auth/factors and POST /auth/stepup calls with proof
// material auth-service actually accepts, rather than stubbing the check.
import { createHmac, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder !== 0) {
    const last = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(last, 2)];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) throw new Error(`invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

// RFC 6238, HMAC-SHA1, 30s step, 6 digits -- matches crypto.go's totpCode/hotp exactly.
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretBase32: string, at: Date = new Date()): string {
  const key = base32Decode(secretBase32);
  const counter = BigInt(Math.floor(at.getTime() / 1000 / 30));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binCode =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binCode % 1_000_000).padStart(6, "0");
}

// ECDSA P-256 / SHA-256, matching crypto.go's verifyPasskeySignature exactly:
// Node's SPKI DER export == Go's x509.MarshalPKIXPublicKey, and Node's
// default ASN.1 DER ECDSA signature encoding == Go's ecdsa.SignASN1.
export interface PasskeyKeyPair {
  publicKeyDer: Buffer;
  sign(challenge: Buffer): Buffer;
}

export function generatePasskeyKeyPair(): PasskeyKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKeyDer,
    sign: (challenge: Buffer) => cryptoSign("sha256", challenge, privateKey as KeyObject),
  };
}

export function randomChallenge(): Buffer {
  return randomBytes(32);
}
