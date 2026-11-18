// Paired devices. The app decides where it keeps them.

// The public key identifies the device. The times are ISO strings.
export type TrustedDevice = { publicKey: string; name: string; pairedAt: string; lastSeen?: string };

// What the peer code needs from the app's storage. The app lists and removes devices itself.
export interface TrustStore {
  get(publicKey: string): Promise<TrustedDevice | undefined>;
  save(device: TrustedDevice): Promise<void>;
}
