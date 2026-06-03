import { getLogger } from "../logging";
let log = getLogger('ApiClient');


export class BaseApiClient {
    host: string; //
    port?: number;
    path: string; // Url path with a leading slash
    debug: boolean;

    constructor(host: string = 'http://localhost', port?: number, path: string = '', debug: boolean = false) {
        this.debug = debug;

        //Handle trailing slashes in host and path
        if (host.endsWith('/')) {
            host = host.slice(0, -1);
        }
        if (path.endsWith('/')) {
            path = path.slice(0, -1);
        }

        // Handle missing slash in path
        if (!path.startsWith('/')) {
            if (path !== '') {
                log.warning(`ApiClient: path "${path}" missing leading slash, adding /`);
            }
            path = '/' + path;
        }

        // Handle missing protocol
        if (!host.startsWith('http')) {
            host = 'http://' + host;
            log.warning(`ApiClient: host ${host} missing protocol, adding http://`);
        }

        // Set default port based on protocol if port is not provided
        if (!port) {
            const url = new URL(host);
            port = url.protocol === 'https:' ? 443 : 80;
        }

        this.host = host;
        this.port = port;
        this.path = path;
    }

    // Form a url from the endpoint
    endpointUrl(endpoint: string): string {
        if (endpoint.startsWith('/')) {
            endpoint = endpoint.slice(1);
        }
        let path = this.path;
        if (!path.endsWith('/')) {
            path = path + '/';
        }
        let url = `${this.host}:${this.port}${this.path}${endpoint}`
        // log.info('host, port, path, endpoint, url', this.host, this.port, path, endpoint, url)
        return url;
    }

    async request(method: string, url: string, data: object = {}, cache: boolean = false, timeout = 20000): Promise<any> {

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);

        const requestRepr = `'${method} ${url}'`;

        const options: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
            cache: cache ? 'default' : 'no-store',
            signal: controller.signal,
        };

        if (method === 'POST' || method === 'PATCH') {
            options.body = JSON.stringify(data);
        } else if (Object.keys(data).length > 0) {
            throw new Error(`HTTP method ${method} should not have a body.`);
        }

        if (this.debug) {
            log.info(`Requesting ${requestRepr} with data:`, data);
        }

        let response: Response;
        try {
            response = await Promise.race([
                fetch(url, options),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Request ${requestRepr} timed out`)), timeout)
                )
            ]) as Response;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                throw new Error(`Request ${requestRepr} timed out`);
            }
            throw error;
        }
        clearTimeout(id);

        if (response.ok) {
            let jsonData = await response.json();  // TODO: fix this ..?
            if (this.debug) {
                log.info(`Response from ${requestRepr}:`, jsonData);
            }

            if (!jsonData ) {
                return null;
            } else if (jsonData.data === undefined) {
                return null;
            } else {
                return jsonData.data;
            }
        } else {
            if (response.status === 422) {
                const errorDetails = await response.json();
                log.error('Validation error:', errorDetails);
            }

            log.error(`Request to ${response.url} failed with status ${response.status}: ${response.statusText}`);
            throw new Error(response.statusText);
        }
    }
    async get(url: string): Promise<any> {
        return this.request('GET', url, {}, true);
    }

    async post(url: string, data: object = {}): Promise<any> {
        return this.request('POST', url, data);
    }

    async patch(url: string, data: object = {}): Promise<any> {
        return this.request('PATCH', url, data);
    }

    async delete(url: string): Promise<any> {
        return this.request('DELETE', url);
    }
    async fetchData(url: string): Promise<any> {
        log.warning('fetchData is deprecated, use get instead');
        return this.get(url);
    }
}
