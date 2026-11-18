// Pairing: one device shows an offer (as a QR code), the other proves that it read it.
import { type DeviceIdentity, randomText, seal, unseal } from "./identity";
import type { TrustedDevice, TrustStore } from "./trust";
import type { Account, Envelope } from "./xmppSignaling";

// What the QR code carries: how to reach the showing device, its key and name, and a one-time code.
export type PairingOffer = Account & { publicKey: string; name: string; code: string };
type PairingRequest = { type: "pair"; code: string; name: string };
// The answer to an accepted request.
export type PairingConfirmation = { type: "paired" };

const codeLifetime = 5 * 60 * 1000;

// A pairing code works once, and only for a few minutes.
export class PairingCode {
  readonly text = randomText(16);
  readonly expiresAt = Date.now() + codeLifetime;
  private used = false;

  // Synchronous, so two requests that wait for their decryption together cannot both use it.
  take(candidate: string): boolean {
    if (this.used || Date.now() > this.expiresAt || candidate !== this.text) return false;
    this.used = true;
    return true;
  }
}

// The joining device seals the offer's code and its own name with the shared key.
export async function pairingRequest(
  identity: DeviceIdentity,
  offer: PairingOffer,
  name: string,
): Promise<Envelope> {
  const key = await identity.sharedKey(offer.publicKey);
  const request: PairingRequest = { type: "pair", code: offer.code, name };
  return { from: identity.publicKey, sealed: await seal(key, request) };
}

// The showing device pairs the sender when the envelope is a request with this code.
export async function acceptPairingRequest(
  identity: DeviceIdentity,
  trust: TrustStore,
  envelope: Envelope,
  code: PairingCode,
): Promise<TrustedDevice | null> {
  const request = await unseal<PairingRequest>(await identity.sharedKey(envelope.from), envelope.sealed);
  if (request?.type !== "pair" || !code.take(request.code)) return null;
  const device = { publicKey: envelope.from, name: request.name, pairedAt: new Date().toISOString() };
  await trust.save(device);
  return device;
}

// The joining device pairs the showing device when it confirms the request.
export async function acceptPairingConfirmation(
  identity: DeviceIdentity,
  trust: TrustStore,
  offer: PairingOffer,
  envelope: Envelope,
): Promise<TrustedDevice | null> {
  if (envelope.from !== offer.publicKey) return null;
  const message = await unseal<PairingConfirmation>(await identity.sharedKey(envelope.from), envelope.sealed);
  if (message?.type !== "paired") return null;
  const device = { publicKey: offer.publicKey, name: offer.name, pairedAt: new Date().toISOString() };
  await trust.save(device);
  return device;
}
