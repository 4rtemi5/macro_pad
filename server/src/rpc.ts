import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

export interface RpcContext {
  client: WebSocket;
  remoteAddress?: string;
}

type Handler = (params: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * Minimal JSON-RPC 2.0 server over WebSocket.
 *
 * - Requests/notifications from clients are dispatched to registered handlers.
 * - Notifications (no `id`) never produce a response.
 * - `notify()` broadcasts a server notification to every connected client.
 */
export class RpcServer {
  private handlers = new Map<string, Handler>();
  private clients = new Set<WebSocket>();

  method(name: string, handler: Handler): void {
    if (this.handlers.has(name)) throw new Error(`duplicate RPC method: ${name}`);
    this.handlers.set(name, handler);
  }

  attach(wss: WebSocketServer): void {
    wss.on("connection", (ws: WebSocket, req) => {
      this.clients.add(ws);
      const remoteAddress = req.socket.remoteAddress;
      ws.on("message", (data: RawData) => void this.onMessage(ws, data, remoteAddress));
      ws.on("close", () => this.clients.delete(ws));
      ws.on("error", () => this.clients.delete(ws));
    });
  }

  /** Broadcast a JSON-RPC notification to all connected clients. */
  notify(method: string, params?: unknown): void {
    const envelope: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) envelope.params = params;
    const msg = JSON.stringify(envelope);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Terminate all client connections (used when the listener is rebound). */
  closeAllClients(): void {
    for (const ws of this.clients) {
      try {
        ws.terminate();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }

  private async onMessage(ws: WebSocket, data: RawData, remoteAddress?: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.send(ws, { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
      return;
    }
    if (Array.isArray(msg)) {
      for (const m of msg) await this.handle(ws, m, remoteAddress);
      return;
    }
    await this.handle(ws, msg, remoteAddress);
  }

  private async handle(ws: WebSocket, msg: unknown, remoteAddress?: string): Promise<void> {
    if (!msg || typeof msg !== "object") {
      this.send(ws, { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request" } });
      return;
    }
    const req = msg as Record<string, unknown>;

    // Not a request/notification (e.g. a response to a server-initiated call —
    // this server never calls clients, so there is nothing to match it to).
    if (typeof req.method !== "string") return;

    const id = req.id;
    const hasId = id !== undefined && id !== null;
    const handler = this.handlers.get(req.method);
    if (!handler) {
      if (hasId) {
        this.send(ws, { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: "Method not found" } });
      }
      return;
    }

    try {
      const result = await handler(req.params ?? null, { client: ws, remoteAddress });
      if (hasId) this.send(ws, { jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      if (!hasId) return;
      if (err instanceof RpcError) {
        const error: Record<string, unknown> = { code: err.code, message: err.message };
        if (err.data !== undefined) error.data = err.data;
        this.send(ws, { jsonrpc: "2.0", id, error });
      } else {
        this.send(ws, {
          jsonrpc: "2.0",
          id,
          error: { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : "Internal error" },
        });
      }
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }
}
