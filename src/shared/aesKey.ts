const AES_256_KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

/** Decode the deployment master key only when it is canonical base64 for 32 bytes. */
export function decodeAes256Key(value: string): Buffer {
  if (!AES_256_KEY_BASE64.test(value)) {
    throw new Error("AES_ENCRYPTION_KEY must be 32 bytes in canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("AES_ENCRYPTION_KEY must be 32 bytes in canonical base64");
  }
  return decoded;
}
