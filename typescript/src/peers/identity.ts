// Device key pairs and the encryption of the setup messages between paired devices.
import { openDB } from "idb";

export type Sealed = { iv: string; data: string };

// One key pair per device, shared by all sivkit apps that run in the same storage.
const databaseName = "sivkit-peers";
// Older messages, and messages this far in the future, are dropped against replay.
const maxMessageAge = 2 * 60 * 1000;

const toBase64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

export const randomText = (byteCount: number) =>
  toBase64(crypto.getRandomValues(new Uint8Array(byteCount)));

// This device's X25519 key pair. The label goes into the key derivation, so each app gets its own
// shared keys.
export class DeviceIdentity {
  private readonly keys: CryptoKeyPair;
  private readonly label: string;
  readonly publicKey: string;

  private constructor(keys: CryptoKeyPair, publicKey: string, label: string) {
    this.keys = keys;
    this.publicKey = publicKey;
    this.label = label;
  }

  // Makes the key pair at the first start. The private key is not extractable: the page can use
  // it, but cannot read it. IndexedDB stores the CryptoKey objects themselves.
  static async load(label: string): Promise<DeviceIdentity> {
    const database = await openDB(databaseName, 1, {
      upgrade: (db) => db.createObjectStore("keys"),
    });
    let keys: CryptoKeyPair | undefined = await database.get("keys", "device");
    if (!keys) {
      keys = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
      ])) as CryptoKeyPair;
      await database.put("keys", keys, "device");
    }
    database.close();
    const publicKey = toBase64(await crypto.subtle.exportKey("raw", keys.publicKey));
    return new DeviceIdentity(keys, publicKey, label);
  }

  // Both devices get the same AES key from their own private key and the other's public key.
  async sharedKey(peerKey: string): Promise<CryptoKey> {
    const peer = await crypto.subtle.importKey("raw", fromBase64(peerKey), { name: "X25519" }, true, []);
    const secret = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, this.keys.privateKey, 256);
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: new TextEncoder().encode(this.label),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
}

// The sealed message carries its sending time.
export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ sentAt: Date.now(), value }));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { iv: toBase64(iv), data: toBase64(data) };
}

// Returns null when the message was not sealed with this key, or when it is too old.
export async function unseal<T>(key: CryptoKey, sealed: Sealed): Promise<T | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(sealed.iv) },
      key,
      fromBase64(sealed.data),
    );
    const { sentAt, value } = JSON.parse(new TextDecoder().decode(plain)) as { sentAt: number; value: T };
    return Math.abs(Date.now() - sentAt) <= maxMessageAge ? value : null;
  } catch {
    return null;
  }
}
