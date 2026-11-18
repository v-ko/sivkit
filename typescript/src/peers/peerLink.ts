// One WebRTC connection to one paired device.

// STUN and TURN servers are chosen later, with hosting.
const iceServers: RTCIceServer[] = [];
// The answer echoes the offer's call ID, so an answer to an older offer is ignored.
export type Signal = { type: "offer" | "answer"; sdp: string; call: string };
export type LinkStatus = "connecting" | "connected" | "reconnecting" | "offline";

export type PeerLinkEvents = {
  send: (signal: Signal) => void;
  log: (line: string) => void;
  onStatus?: (status: LinkStatus) => void;
  onTrack?: (track: MediaStreamTrack) => void;
};

// A disconnected connection often recovers alone, for example after a short Wi-Fi drop.
const recoveryWait = 5000;

// The calling side offers its tracks and the other side answers. Each side sends its description
// only after ICE gathering is complete, so one message per side is enough. When the connection is
// lost, the calling side calls again.
export class PeerLink {
  private readonly events: PeerLinkEvents;
  private connection: RTCPeerConnection | null = null;
  private currentCall = "";
  // Set on the calling side, for the next call.
  private tracks: MediaStreamTrack[] | null = null;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(events: PeerLinkEvents) {
    this.events = events;
  }

  get connected(): boolean {
    return this.connection?.connectionState === "connected";
  }

  // Replaces the current connection with a new call that sends these tracks.
  async call(tracks: MediaStreamTrack[]): Promise<void> {
    const call = crypto.randomUUID();
    const connection = this.newConnection(call);
    this.tracks = tracks;
    for (const track of tracks) connection.addTransceiver(track, { direction: "sendonly" });
    await connection.setLocalDescription();
    await this.sendDescription(connection, call);
  }

  async receive(signal: Signal): Promise<void> {
    this.events.log(`received ${signal.type}`);
    if (signal.type === "offer") {
      const connection = this.newConnection(signal.call);
      this.tracks = null;
      await connection.setRemoteDescription(signal);
      await connection.setLocalDescription();
      await this.sendDescription(connection, signal.call);
    } else if (signal.call === this.currentCall) {
      await this.connection?.setRemoteDescription(signal);
    } else {
      this.events.log("ignored answer to an older offer");
    }
  }

  close(): void {
    clearTimeout(this.retryTimer);
    this.tracks = null;
    this.connection?.close();
    this.connection = null;
    this.events.onStatus?.("offline");
  }

  private newConnection(call: string): RTCPeerConnection {
    clearTimeout(this.retryTimer);
    this.connection?.close();
    const connection = new RTCPeerConnection({ iceServers });
    connection.onconnectionstatechange = () => {
      // A replaced connection reports nothing.
      if (connection === this.connection) this.onStateChange(connection.connectionState);
    };
    connection.ontrack = ({ track }) => this.events.onTrack?.(track);
    this.connection = connection;
    this.currentCall = call;
    this.events.onStatus?.("connecting");
    return connection;
  }

  private onStateChange(state: RTCPeerConnectionState): void {
    const { events, tracks } = this;
    clearTimeout(this.retryTimer);
    if (state === "connected") {
      events.onStatus?.("connected");
    } else if (state === "disconnected") {
      events.onStatus?.("reconnecting");
      if (tracks) this.retryTimer = setTimeout(() => this.callAgain(tracks), recoveryWait);
    } else if (state === "failed") {
      // The answering side waits for a new offer.
      events.onStatus?.(tracks ? "reconnecting" : "offline");
      if (tracks) this.callAgain(tracks);
    }
  }

  private callAgain(tracks: MediaStreamTrack[]): void {
    this.events.log("calling again");
    this.call(tracks).catch((error) => this.events.log(`error: ${error}`));
  }

  private async sendDescription(connection: RTCPeerConnection, call: string): Promise<void> {
    await gatheringComplete(connection);
    const { type, sdp } = connection.localDescription!;
    this.events.send({ type: type as Signal["type"], sdp, call });
    this.events.log(`sent ${type}`);
  }
}

function gatheringComplete(connection: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve();
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState === "complete") resolve();
    });
  });
}
