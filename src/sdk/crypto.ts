import { x25519, ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export const toBase64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
export const fromBase64 = (data: string) => new Uint8Array(Buffer.from(data, "base64"));

export const createIdentity = () => {
  const ed25519PrivateKey = ed25519.utils.randomPrivateKey();
  const ed25519PublicKey = ed25519.getPublicKey(ed25519PrivateKey);
  const x25519PrivateKey = x25519.utils.randomPrivateKey();
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);
  const id = toBase64(ed25519PublicKey);
  return {
    id,
    ed25519PrivateKey,
    ed25519PublicKey,
    x25519PrivateKey,
    x25519PublicKey
  };
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `"${key}":${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export const signPayload = (payload: unknown, privateKey: Uint8Array) => {
  const msg = textEncoder.encode(stableStringify(payload));
  const signature = ed25519.sign(msg, privateKey);
  return toBase64(signature);
};

export const verifyPayload = (
  payload: unknown,
  signatureBase64: string,
  publicKey: Uint8Array
) => {
  const msg = textEncoder.encode(stableStringify(payload));
  const signature = fromBase64(signatureBase64);
  return ed25519.verify(signature, msg, publicKey);
};

export const deriveDirectKey = (
  conversationId: string,
  localPrivateKey: Uint8Array,
  remotePublicKey: Uint8Array
) => {
  const sharedSecret = x25519.getSharedSecret(localPrivateKey, remotePublicKey);
  const salt = sha256(textEncoder.encode("waku-chat"));
  const info = textEncoder.encode(`direct:${conversationId}`);
  return hkdf(sha256, sharedSecret, salt, info, 32);
};

export const deriveGroupKey = (conversationId: string, sharedKey: Uint8Array) => {
  const salt = sha256(textEncoder.encode("waku-chat"));
  const info = textEncoder.encode(`group:${conversationId}`);
  return hkdf(sha256, sharedKey, salt, info, 32);
};

export const encryptPayload = (plaintext: string, key: Uint8Array) => {
  const nonce = ed25519.utils.randomPrivateKey().slice(0, 24);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(textEncoder.encode(plaintext));
  return {
    nonce: toBase64(nonce),
    ciphertext: toBase64(ciphertext)
  };
};

export const decryptPayload = (ciphertextBase64: string, nonceBase64: string, key: Uint8Array) => {
  const nonce = fromBase64(nonceBase64);
  const ciphertext = fromBase64(ciphertextBase64);
  const cipher = xchacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return textDecoder.decode(plaintext);
};

export const sha256Base64 = (data: Uint8Array) => toBase64(sha256(data));

export const canonicalId = (parts: Array<string>) => {
  const payload = textEncoder.encode(parts.join("|"));
  return sha256Base64(payload);
};
