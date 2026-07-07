/**
 * compute-spa-relay-client — Browser WebSocket relay client
 *
 * Zero Deno APIs. Browser-native fetch and WebSocket only.
 * Connects to the did-key-relay dispatcher, handles nonce/registration,
 * dispatches request/response frames.
 */

export const SUBSCRIBE_NSID = "com.fedproxy.temp.xrpc.subscribe";
export const GET_NONCE_NSID = "com.fedproxy.temp.xrpc.getRegistrationNonce";
export const SUBMIT_BID_NSID = "com.publicdomainrelay.temp.market.submitBid";
export const SUBMIT_EVENT_NSID = "com.publicdomainrelay.temp.market.submitEvent";

interface RegisteredFrame {
  $type: string;
  subdomain: string;
  proxyRef: string;
}

interface RequestFrame {
  $type: string;
  requestId: string;
  method: string;
  path: string;
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

interface ResponseFrame {
  $type: string;
  requestId: string;
  status: number;
  body: unknown;
  contentType?: string;
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Browser-side WebSocket relay client for the did-key-relay dispatcher.
 *
 * Connects to the dispatcher, registers with a signed nonce, and handles
 * bidirectional request/response frames over the subscription WebSocket.
 * Designed for browser contexts only — zero Deno APIs.
 */
export class RelayClient {
  #dispatcherHost: string;
  #keypair: { did(): string; sign(bytes: Uint8Array): Promise<Uint8Array> };
  #serviceAuthMinter: (lxm: string) => Promise<string>;

  #ws: WebSocket | null = null;
  #status: string = "disconnected";
  #subdomain: string | null = null;
  #proxyRef: string | null = null;
  #requestIdCounter = 0;
  #pendingRequests = new Map<
    string,
    {
      resolve: (r: { status: number; body: unknown }) => void;
      reject: (e: unknown) => void;
    }
  >();
  #closed = false;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempts = 0;

  onBid: ((bid: unknown) => void) | null = null;
  onStateChange: ((status: string) => void) | null = null;

  constructor(opts: {
    dispatcherHost: string;
    keypair: { did(): string; sign(bytes: Uint8Array): Promise<Uint8Array> };
    serviceAuthMinter: (lxm: string) => Promise<string>;
  }) {
    this.#dispatcherHost = opts.dispatcherHost;
    this.#keypair = opts.keypair;
    this.#serviceAuthMinter = opts.serviceAuthMinter;
  }

  get status(): string {
    return this.#status;
  }

  get subdomain(): string | null {
    return this.#subdomain;
  }

  get proxyRef(): string | null {
    return this.#proxyRef;
  }

  #setStatus(s: string) {
    this.#status = s;
    this.onStateChange?.(s);
  }

  /**
   * Open a WebSocket to the dispatcher, obtain a nonce, sign it with the
   * keypair, and register. Resolves once the `#registered` frame arrives.
   */
  async start(): Promise<void> {
    if (this.#closed) return;
    if (this.#status !== "disconnected") return;
    this.#setStatus("connecting");

    try {
      const registration = await this.#buildRegistration();
      const subscribeToken = await this.#serviceAuthMinter(SUBSCRIBE_NSID);
      const did = this.#keypair.did();

      const url =
        `wss://${this.#dispatcherHost}/xrpc/${SUBSCRIBE_NSID}?registration=${
          encodeURIComponent(registration)
        }&did=${encodeURIComponent(did)}&service_auth=${
          encodeURIComponent(subscribeToken)
        }`;

      const ws = new WebSocket(url);
      this.#ws = ws;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error("registration timeout"));
          }
        }, 30_000);

        ws.onopen = () => {
          this.#setStatus("connected");
          this.#reconnectAttempts = 0;
        };

        ws.onmessage = (evt: MessageEvent) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(evt.data as string);
          } catch {
            return;
          }

          const $type = msg.$type as string | undefined;
          if (!$type) return;

          if ($type === `${SUBSCRIBE_NSID}#registered`) {
            clearTimeout(timeout);
            const f = msg as unknown as RegisteredFrame;
            this.#subdomain = f.subdomain;
            this.#proxyRef = f.proxyRef;
            this.#setStatus("registered");
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }

          if ($type === `${SUBSCRIBE_NSID}#response`) {
            const f = msg as unknown as ResponseFrame;
            const pending = this.#pendingRequests.get(f.requestId);
            if (pending) {
              this.#pendingRequests.delete(f.requestId);
              pending.resolve({ status: f.status, body: f.body });
            }
            return;
          }

          if ($type === `${SUBSCRIBE_NSID}#request`) {
            this.#handleIncomingRequest(msg as unknown as RequestFrame);
            return;
          }
        };

        ws.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("WebSocket error during registration"));
          }
        };

        ws.onclose = () => {
          this.#subdomain = null;
          this.#proxyRef = null;
          this.#setStatus("disconnected");

          for (const [id, p] of this.#pendingRequests) {
            p.reject(new Error("WebSocket closed"));
            this.#pendingRequests.delete(id);
          }

          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error("closed before registration"));
          }

          this.#scheduleReconnect();
        };
      });
    } catch (err) {
      this.#ws = null;
      this.#setStatus("disconnected");
      throw err;
    }
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    const delay = Math.min(1000 * 2 ** this.#reconnectAttempts, 30_000);
    this.#reconnectAttempts++;
    this.#connectTimer = setTimeout(() => {
      this.#connectTimer = null;
      if (this.#closed) return;
      this.#setStatus("connecting");
      this.start().catch(() => {
        this.#scheduleReconnect();
      });
    }, delay);
  }

  async #buildRegistration(): Promise<string> {
    const token = await this.#serviceAuthMinter(GET_NONCE_NSID);
    const did = this.#keypair.did();

    const res = await fetch(
      `https://${this.#dispatcherHost}/xrpc/${GET_NONCE_NSID}`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: did, signatures: [] }),
      },
    );

    if (!res.ok) {
      throw new Error(
        `nonce request failed: ${res.status} ${await res.text()}`,
      );
    }

    const { nonce } = (await res.json()) as { nonce: string };
    const sig = await this.#keypair.sign(b64decode(nonce));

    return JSON.stringify({
      $type: "com.fedproxy.temp.xrpc.registration",
      key: did,
      nonce,
      signatures: [{ key: did, signature: b64encode(sig) }],
    });
  }

  #handleIncomingRequest(frame: RequestFrame) {
    if (frame.path === SUBMIT_BID_NSID) {
      this.onBid?.(frame.body);
      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#response`,
        requestId: frame.requestId,
        status: 200,
        body: { ok: true },
      });
      return;
    }

    this.#sendFrame({
      $type: `${SUBSCRIBE_NSID}#response`,
      requestId: frame.requestId,
      status: 501,
      body: {
        error: "NotImplemented",
        message: `no handler for ${frame.path}`,
      },
    });
  }

  #sendFrame(frame: unknown) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Send a request frame over the WebSocket and await the response.
   * Resolves with `{ status, body }` when the dispatcher replies.
   * Rejects after 30 seconds if no response arrives.
   */
  async sendRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const requestId = String(++this.#requestIdCounter);

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(requestId, { resolve, reject });

      this.#sendFrame({
        $type: `${SUBSCRIBE_NSID}#request`,
        requestId,
        method,
        path,
        body,
        params: {},
        headers: {},
      });

      setTimeout(() => {
        const pending = this.#pendingRequests.get(requestId);
        if (pending) {
          this.#pendingRequests.delete(requestId);
          reject(new Error("request timeout"));
        }
      }, 30_000);
    });
  }

  /**
   * Close the WebSocket and cancel any pending reconnect.
   * Pending requests are rejected with "client closed".
   */
  close(): void {
    this.#closed = true;
    if (this.#connectTimer) {
      clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
    this.#subdomain = null;
    this.#proxyRef = null;
    this.#setStatus("disconnected");

    for (const [id, p] of this.#pendingRequests) {
      p.reject(new Error("client closed"));
      this.#pendingRequests.delete(id);
    }
  }
}
