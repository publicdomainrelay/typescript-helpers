import type { LoggerInterface } from "@publicdomainrelay/logger";

export interface ReconnectingWebSocketOptions {
  endpoint: () => string;
  onMessage: (data: string) => void;
  onOpen?: () => void;
  label?: string;
  log?: LoggerInterface;
  maxBackoffMs?: number;
}

export function createReconnectingWebSocket(
  opts: ReconnectingWebSocketOptions,
): { close(): void } {
  const { onMessage, onOpen, label, log, maxBackoffMs } = opts;
  const maxBackoff = maxBackoffMs ?? 30000;
  let retryCount = 0;
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const prefix = label ? `${label}_` : "";

  function connect(): void {
    if (closed) return;
    log?.info(`${prefix}connecting`, {});
    try {
      ws = new WebSocket(opts.endpoint());
    } catch (err) {
      log?.error(`${prefix}ws_constructor_failed`, { err: String(err) });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log?.info(`${prefix}connected`, {});
      onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      retryCount = 0;
      try {
        if (typeof event.data !== "string") return;
        onMessage(event.data);
      } catch {
      }
    };

    ws.onerror = () => {
      log?.warn(`${prefix}ws_error`, {});
    };

    ws.onclose = () => {
      log?.info(`${prefix}disconnected`, {});
      ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = Math.min(1000 * Math.pow(2, retryCount), maxBackoff);
    retryCount++;
    log?.info(`${prefix}reconnect_scheduled`, { delayMs: delay, retryCount });
    reconnectTimer = setTimeout(connect, delay);
  }

  function close(): void {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {
    }
    ws = null;
  }

  connect();
  return { close };
}
