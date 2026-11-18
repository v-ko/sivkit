// XMPP as the signaling channel between the devices of one account.
import { $iq, $msg, $pres, Strophe } from "strophe.js";
import { type DeviceIdentity, type Sealed, seal, unseal } from "./identity";
import type { TrustedDevice, TrustStore } from "./trust";

export type Account = { service: string; account: string; password: string };
// `from` is the sender's public key. It selects the shared key for the sealed message.
export type Envelope = { from: string; sealed: Sealed };
export type SignalingStatus = "connecting" | "online" | "reconnecting" | "offline";

export type SignalingEvents = {
  log: (line: string) => void;
  onStatus?: (status: SignalingStatus) => void;
  onPeerOnline?: () => void;
  // A message from a paired device.
  onMessage: (device: TrustedDevice, message: unknown) => Promise<void> | void;
  // An envelope from a key that is not paired, for example a pairing request.
  onUnknownSender?: (envelope: Envelope) => Promise<void> | void;
  // Another password to try after a rejected login, for example after an unconfirmed change.
  onAuthFailed?: () => string | undefined;
};

const firstRetryDelay = 1000;
const maxRetryDelay = 30_000;

const statusNames = new Map<number, string>(
  Object.entries(Strophe.Status).map(([name, value]) => [value, name]),
);

// Logs in as `account/resource` and exchanges sealed messages with the peer resource of the same
// account. It logs in again after a lost connection.
export class XmppSignaling {
  private readonly connection: InstanceType<typeof Strophe.Connection>;
  private readonly account: Account;
  private password: string;
  private readonly resource: string;
  private readonly peerJid: string;
  private readonly identity: DeviceIdentity;
  private readonly trust: TrustStore;
  private readonly events: SignalingEvents;
  private retryDelay = firstRetryDelay;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private authFailed = false;

  constructor(
    account: Account,
    resource: string,
    peerResource: string,
    identity: DeviceIdentity,
    trust: TrustStore,
    events: SignalingEvents,
  ) {
    this.connection = new Strophe.Connection(account.service);
    this.account = account;
    this.password = account.password;
    this.resource = resource;
    this.peerJid = `${account.account}/${peerResource}`;
    this.identity = identity;
    this.trust = trust;
    this.events = events;
    this.connect("connecting");
  }

  // Seals the message for one paired device.
  async send(publicKey: string, message: unknown): Promise<void> {
    const sealed = await seal(await this.identity.sharedKey(publicKey), message);
    this.sendEnvelope({ from: this.identity.publicKey, sealed });
  }

  sendEnvelope(envelope: Envelope): void {
    // Strophe would keep the message and send it before the next login.
    if (!this.connection.authenticated) return this.events.log("not sent: XMPP is offline");
    this.connection.send($msg({ to: this.peerJid, type: "chat" }).c("body").t(JSON.stringify(envelope)));
  }

  // XEP-0077: the server sets a new password for the logged-in account. Later logins use it.
  changePassword(password: string): Promise<void> {
    const [username, domain] = this.account.account.split("@");
    const request = $iq({ type: "set", to: domain })
      .c("query", { xmlns: "jabber:iq:register" })
      .c("username").t(username).up()
      .c("password").t(password);
    return new Promise((resolve, reject) => {
      this.connection.sendIQ(
        request,
        () => {
          this.password = password;
          resolve();
        },
        (error) => reject(new Error(error ? "the server refused the new password" : "no answer from the server")),
        10_000,
      );
    });
  }

  disconnect(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.connection.disconnect();
  }

  private connect(status: SignalingStatus): void {
    this.events.onStatus?.(status);
    const { account, connection, resource, events } = this;
    // Strophe requires a reset before it reuses a connection. It also drops the old handlers.
    connection.reset();
    connection.connect(`${account.account}/${resource}`, this.password, (status, condition) => {
      events.log(`XMPP ${statusNames.get(status) ?? status}${condition ? `: ${condition}` : ""}`);
      if (status === Strophe.Status.CONNECTED) this.onConnected();
      if (status === Strophe.Status.AUTHFAIL) {
        // A wrong password does not get better with time. A resource conflict with an old
        // session of this device does. Strophe does not disconnect by itself here.
        if (condition !== "conflict") {
          const otherPassword = events.onAuthFailed?.();
          if (otherPassword) this.password = otherPassword;
          else this.authFailed = true;
        }
        connection.disconnect();
      }
      if (status === Strophe.Status.DISCONNECTED) this.onDisconnected();
    });
  }

  private onConnected(): void {
    const { connection, events, peerJid } = this;
    this.retryDelay = firstRetryDelay;
    events.onStatus?.("online");
    // Resources of one account get each other's presence, so this fires on both sides.
    connection.addHandler(
      (presence) => {
        const online = presence.getAttribute("type") !== "unavailable";
        events.log(`${peerJid} is ${online ? "online" : "offline"}`);
        if (online) events.onPeerOnline?.();
        return true;
      },
      null,
      "presence",
      null,
      null,
      peerJid,
    );
    connection.addHandler(
      (message) => {
        const text = message.getElementsByTagName("body")[0]?.textContent;
        // A handler that throws is removed by Strophe, so the async errors are only logged.
        if (text) this.receive(text).catch((error) => events.log(`ignored a message: ${error}`));
        return true;
      },
      null,
      "message",
      "chat",
      null,
      peerJid,
    );
    connection.send($pres());
  }

  private onDisconnected(): void {
    if (this.stopped || this.authFailed) return this.events.onStatus?.("offline");
    this.events.log(`logging in again in ${this.retryDelay / 1000} s`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect("reconnecting"), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, maxRetryDelay);
    this.events.onStatus?.("reconnecting");
  }

  private async receive(text: string): Promise<void> {
    const envelope = JSON.parse(text) as Envelope;
    const device = await this.trust.get(envelope.from);
    if (!device) {
      if (this.events.onUnknownSender) return await this.events.onUnknownSender(envelope);
      return this.events.log("ignored a message from an unknown key");
    }
    const message = await unseal(await this.identity.sharedKey(device.publicKey), envelope.sealed);
    if (message === null) return this.events.log(`ignored a message from ${device.name}: bad or too old`);
    // The app can stop the signaling and remove the device while the message decrypts.
    if (this.stopped) return;
    const seen = { ...device, lastSeen: new Date().toISOString() };
    await this.events.onMessage(seen, message);
    await this.trust.save(seen);
  }
}
