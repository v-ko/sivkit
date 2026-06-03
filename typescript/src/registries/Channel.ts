import { getLogger } from "sivkit/logging";

let log = getLogger('Channel');

export type HandlerFunction = (message: any) => void;
let CREATING_CHANNEL: string | null = null;

// Unique ID for each tab/window instance (used only to prevent double-delivery
// if a BroadcastChannel implementation ever echoes back to the same context).
const INSTANCE_ID = `${Date.now()}-${Math.random()}`;

interface ChannelBackend {
    push(message: any): void;
    subscribe(handler: HandlerFunction, indexVal?: any): Subscription;
    removeSubscription(handler: HandlerFunction, indexVal?: any): void;
    close(): void;
    clearSubscriptions(): void;
}

export class Subscription {
    id: number;
    handler: HandlerFunction;
    channel: Channel;
    indexVal: any;

    constructor(handler: HandlerFunction, channel: Channel, indexVal: any = undefined) {
        this.id = Date.now() + Math.random(); // A unique identifier
        this.handler = handler;
        this.channel = channel;
        this.indexVal = indexVal;
    }

    unsubscribe(): void {
        this.channel.removeSubscription(this.handler, this.indexVal);
    }
}

// Base class that handles subscription management and indexing logic
abstract class BaseChannelBackend implements ChannelBackend {
    protected indexedSubscriptions: Map<any, Map<symbol, HandlerFunction>> = new Map();
    protected nonIndexedSubscriptions: Map<symbol, HandlerFunction> = new Map();
    protected channel: Channel;
    protected closed = false;

    constructor(channel: Channel) {
        this.channel = channel;
    }

    close(): void {
        log.info(`Closing channel: ${this.channel.name}`);
        this.closed = true;
        this.clearSubscriptions();
    }

    protected assertOpen() {
        if (this.closed) throw new Error('Channel is closed');
    }

    abstract push(message: any): void;

    // Common method to handle incoming messages (local fanout in the same JS context)
    protected handleIncomingMessage(message: any): void {
        log.info(`Handling message for channel: ${this.channel.name}`, message);
        if (this.channel.subchannelClassifier && !this.channel.subchannelClassifier(message)) {
            log.info(`Message filtered out by subchannelClassifier: ${message}`);
            return;
        }

        const messageIndex = this.channel.subchannel ? this.channel.subchannel(message) : null;

        // Handle indexed messages
        if (messageIndex !== null && this.indexedSubscriptions.has(messageIndex)) {
            const handlers = this.indexedSubscriptions.get(messageIndex);
            handlers?.forEach((handler) => callDelayed(handler, message));
        }

        // Handle non-indexed messages
        this.nonIndexedSubscriptions.forEach((handler) => {
            callDelayed(handler, message);
        });
    }

    subscribe(handler: HandlerFunction, indexVal: any = undefined): Subscription {
        this.assertOpen();
        // Using a per-channel symbol derived from handler.toString().
        // This keeps removeSubscription simple while allowing duplicates across channels.
        const handlerSymbol = Symbol.for(handler.toString());
        if (indexVal !== undefined) {
            // Indexed subscription
            let handlersMap = this.indexedSubscriptions.get(indexVal);
            if (!handlersMap) {
                handlersMap = new Map();
                this.indexedSubscriptions.set(indexVal, handlersMap);
            }
            handlersMap.set(handlerSymbol, handler);
        } else {
            // Non-indexed subscription
            this.nonIndexedSubscriptions.set(handlerSymbol, handler);
        }
        return new Subscription(handler, this.channel, indexVal);
    }

    removeSubscription(handler: HandlerFunction, indexVal: any = undefined): void {
        const handlerSymbol = Symbol.for(handler.toString());
        if (indexVal !== undefined) {
            // Remove indexed subscription
            const handlersMap = this.indexedSubscriptions.get(indexVal);
            handlersMap?.delete(handlerSymbol);
            if (handlersMap && handlersMap.size === 0) {
                this.indexedSubscriptions.delete(indexVal);
            }
        } else {
            // Remove non-indexed subscription
            this.nonIndexedSubscriptions.delete(handlerSymbol);
        }
    }

    clearSubscriptions(): void {
        this.indexedSubscriptions.clear();
        this.nonIndexedSubscriptions.clear();
    }
}

class LocalBackend extends BaseChannelBackend {
    push(message: any): void {
        log.info(`Pushing message to local channel: ${this.channel.name}`, message);
        this.assertOpen();
        // Local backend directly handles the message in the same context
        this.handleIncomingMessage(message);
    }
}

interface WrappedMessage {
    _instanceId: string;
    payload?: any;
}
class BroadcastChannelBackend extends BaseChannelBackend {
    private broadcastChannel: BroadcastChannel;

    constructor(channel: Channel) {
        super(channel);
        this.broadcastChannel = new BroadcastChannel(channel.name);
        this.broadcastChannel.onmessage = (event) => {
            const wrappedMessage = event.data;

            // Many implementations do not echo to the same context, but guard anyway.
            if (wrappedMessage && wrappedMessage._instanceId === INSTANCE_ID) {
                return; // ignore self-originated BC messages
            }

            // Fan out to local subscribers in this context
            this.handleIncomingMessage((wrappedMessage as WrappedMessage).payload);
        };
    }

    push(message: any): void {
        log.info(`Pushing message to broadcast channel (hybrid local+bc): ${this.channel.name}`, message);
        this.assertOpen();
        // HYBRID BEHAVIOR:
        // 1) Deliver to local subscribers in *this* JS context immediately
        this.handleIncomingMessage(message);
        // 2) Also broadcast to other contexts (tabs/workers) listening on the same name
        try {
            let wrappedMessage: WrappedMessage = {
                _instanceId: INSTANCE_ID,
                payload: message
            }
            this.broadcastChannel.postMessage(wrappedMessage);
        } catch (e) {
            log.warning?.('BroadcastChannel postMessage failed', e);
        }
    }

    override close(): void {
        super.close();
        try { this.broadcastChannel.close(); } catch { /* noop */ }
    }
}

export class Channel {
    name: string;
    subchannel: ((message: any) => any) | null;
    subchannelClassifier: ((message: any) => boolean) | null;
    private backend: ChannelBackend;

    constructor(name: string, options: {
        backend?: 'local' | 'broadcast';
        subchannel?: (message: any) => any;
        subchannelClassifier?: (message: any) => boolean;
    } = {}) {
        this.name = name;
        this.subchannel = options.subchannel || null;
        this.subchannelClassifier = options.subchannelClassifier || null;

        if (CREATING_CHANNEL !== name) {
            throw new Error('Do not call Channel constructor directly, use sivkit.libs.add() instead.');
        }

        if (options.backend === 'broadcast') {
            if (typeof BroadcastChannel === 'undefined') {
                throw new Error('BroadcastChannel API is not available in this environment');
            }
            this.backend = new BroadcastChannelBackend(this);
        } else {
            this.backend = new LocalBackend(this);
        }
    }

    push(message: any): void {
        this.backend.push(message);
    }

    subscribe(handler: HandlerFunction, indexVal: any = undefined): Subscription {
        return this.backend.subscribe(handler, indexVal);
    }

    removeSubscription(handler: HandlerFunction, indexVal: any = undefined): void {
        this.backend.removeSubscription(handler, indexVal);
    }

    close(): void {
        this.backend.close();
    }

    clearSubscriptions(): void {
        this.backend.clearSubscriptions();
    }
}

function callDelayed(handler: (message: any) => void, message: any): void {
    log.info(`Calling handler`, message);
    queueMicrotask(() => {
        handler(message);
    });
}

// Store for all channels.
const channels = new Map<string, Channel>();

/**
 * Registers a new channel.
 */
export function addChannel(
    name: string,
    options: {
        backend?: 'local' | 'broadcast';
        subchannel?: (message: any) => any;
        subchannelClassifier?: (message: any) => boolean;
    } = {}
): Channel {
    log.info(`Adding channel: ${name}`);
    if (channels.has(name)) {
        throw new Error('A channel with this name already exists');
    }
    CREATING_CHANNEL = name;

    const channel = new Channel(name, options);
    channels.set(name, channel);

    CREATING_CHANNEL = null;
    return channel;
}

/**
 * Removes a channel by its name.
 */
export function removeChannel(name: string) {
    log.info(`Removing channel ${name}`);
    if (!channels.has(name)) {
        throw new Error(`Channel with name "${name}" does not exist and cannot be removed.`);
    }
    const channel = channels.get(name);
    channel?.close();
    channels.delete(name);
}

export function getChannel(name: string): Channel | undefined {
    return channels.get(name);
}

// For testing
export function unsubscribeAll(): void {
    channels.forEach((channel) => {
        channel.clearSubscriptions();
    });
}

export function clearChannels(): void {
    channels.forEach((channel) => {
        channel.close();
    });
    channels.clear();
}
