import { createId } from "./util/base";

let LOG_LEVEL = 0;  // 0: info, 1: warning, 2: error

export class Logger {
    name: string;

    constructor(name: string) {
        this.name = name;
    }
    info(...args: any[]): void {
        if (LOG_LEVEL > 0) {
            return;
        }
        console.info(`[${this.name}]`, ...args);
    }
    warning(...args: any[]): void {
        if (LOG_LEVEL > 1) {
            return;
        }
        console.warn(`[${this.name}]`, ...args);
    }
    error(...args: any[]): void {
        console.error(`[${this.name}]`, ...args);
    }
}

let WEBWORKER_LOGGING_CHANNEL_NAME = 'webworker-logging-channel';
let _webWorkerLoggingChannel: BroadcastChannel | null = null;
// let _webWorkerLoggerWrapper: WebWorkerLoggerWrapper | null = null;

// function webWorkerLoggerWrapper() {
//     if (!_webWorkerLoggerWrapper) {
//         throw new Error('Web worker logging channel not setup');
//     }
//     return _webWorkerLoggerWrapper;
// }

export function setupWebWorkerLoggingChannel(): void {
    // Allow only a single config
    if (_webWorkerLoggingChannel) {
        throw new Error('Web worker logging channel already set');
    }

    _webWorkerLoggingChannel = new BroadcastChannel(WEBWORKER_LOGGING_CHANNEL_NAME);
    // _webWorkerLoggerWrapper = new WebWorkerLoggerWrapper();

    // Setup the wrapper to handle messages
    _webWorkerLoggingChannel.onmessage = (event) => {
        handleWebworkerLoggerMessage(event.data);
    };
}

export interface LogMessage {
    loggerName: string;
    type: 'info' | 'warning' | 'error';
    message: string;
    args: any[];
}
function handleWebworkerLoggerMessage(message: LogMessage): void {
    switch (message.type) {
        case 'info':
            if (LOG_LEVEL > 0) {
                return;
            }
            console.log(`[${message.loggerName}]`, ...message.args);
            break;
        case 'warning':
            if (LOG_LEVEL > 1) {
                return;
            }
            console.warn(`[${message.loggerName}]`, ...message.args);
            break;
        case 'error':
            console.error(`[${message.loggerName}]`, ...message.args);
            break;
    }
}

class WebWorkerLogger implements Logger {
    /**
     * A class to be used from within a web worker to log messages to the main
     * thread.
     */
    name: string;
    _channel: BroadcastChannel;

    constructor(name: string) {
        this.name = name;
        this._channel = new BroadcastChannel(WEBWORKER_LOGGING_CHANNEL_NAME);
    }

    info(...args: any[]): void {
        const message: LogMessage = {
            loggerName: this.name,
            type: 'info',
            message: '',
            args: args
        }
        this._channel.postMessage(message);
    }

    warning(...args: any[]): void {
        const message: LogMessage = {
            loggerName: this.name,
            type: 'warning',
            message: '',
            args: args
        }
        this._channel.postMessage(message);
    }

    error(...args: any[]): void {
        const message: LogMessage = {
            loggerName: this.name,
            type: 'error',
            message: '',
            args: args
        }
        this._channel.postMessage(message);
    }
}


const workerId = createId(8)

export function getLogger(name: string): Logger {
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
        name = `${name}[wid:${workerId}]`
        return new WebWorkerLogger(name)
    } else {
        return new Logger(name);
    }
}

// redundant
// export function getWebWorkerLogger(name: string): WebWorkerLogger {
//     return new WebWorkerLogger(name);
// }
