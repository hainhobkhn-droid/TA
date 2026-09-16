import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
type Box = { nonce: string; ciphertext: string; tag: string };
export type Envelope = {
  version: 1;
  keyId: string;
  wrappedKey: Box;
  data: Box;
};
function seal(key: Buffer, text: Buffer, context: string): Box {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(context));
  return {
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([cipher.update(text), cipher.final()]).toString(
      "base64",
    ),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function open(key: Buffer, box: Box, context: string) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(box.nonce, "base64"),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.ciphertext, "base64")),
    decipher.final(),
  ]);
}
export function encrypt(
  value: unknown,
  context: string,
  config: Pick<Config, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_ID">,
): Envelope {
  const key = randomBytes(32);
  try {
    return {
      version: 1,
      keyId: config.ENCRYPTION_KEY_ID,
      wrappedKey: seal(
        Buffer.from(config.ENCRYPTION_KEY, "hex"),
        key,
        context + ":key",
      ),
      data: seal(key, Buffer.from(JSON.stringify(value)), context + ":data"),
    };
  } finally {
    key.fill(0);
  }
}
export function decrypt<T>(
  envelope: Envelope,
  context: string,
  config: Pick<Config, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_ID">,
): T {
  if (envelope.version !== 1 || envelope.keyId !== config.ENCRYPTION_KEY_ID)
    throw new Error("Unknown encryption key version");
  const key = open(
    Buffer.from(config.ENCRYPTION_KEY, "hex"),
    envelope.wrappedKey,
    context + ":key",
  );
  try {
    return JSON.parse(
      open(key, envelope.data, context + ":data").toString("utf8"),
    ) as T;
  } finally {
    key.fill(0);
  }
}
