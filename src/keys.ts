import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportJwk, importJwk } from "@fedify/fedify";
import { DATA_DIR } from "./config.ts";

let cached: CryptoKeyPair | null = null;

/**
 * The bridge actor's signing key. Persisted so that a restart doesn't rotate
 * the key and invalidate every signature remote servers have cached.
 */
export async function getKeyPair(): Promise<CryptoKeyPair> {
  if (cached) return cached;

  const file = join(DATA_DIR, "key.json");
  try {
    const stored = JSON.parse(await readFile(file, "utf8"));
    cached = {
      privateKey: await importJwk(stored.private, "private"),
      publicKey: await importJwk(stored.public, "public"),
    };
    return cached;
  } catch {
    // no key yet, generate one
  }

  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    file,
    JSON.stringify(
      {
        public: await exportJwk(pair.publicKey),
        private: await exportJwk(pair.privateKey),
      },
      null,
      2,
    ),
  );

  cached = pair;
  return pair;
}
