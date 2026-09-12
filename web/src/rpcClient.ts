type NotificationHandler = (params: never) => void;
type ConnectionHandler = (connected: boolean) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
}

/**
 * Reconnecting JSON-RPC 2.0 client over WebSocket.
 * Calls are promise-based; server notifications are dispatched to subscribers.
 */
export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private handlers = new Map<string, Set<NotificationHandler>>();
  private connHandlers = new Set<ConnectionHandler>();
  private delay = 500;
  private closed = false;

  constructor(private url: string) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.delay = 500;
      for (const cb of this.connHandlers) cb(true);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.ws = null;
      for (const cb of this.connHandlers) cb(false);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("disconnected"));
      }
      this.pending.clear();
      if (!this.closed) {
        this.delay = Math.min(this.delay * 2, 10_000);
        setTimeout(() => this.connect(), this.delay);
      }
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("not connected"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? null, id }));
    });
  }

  on<P = unknown>(method: string, handler: (params: P) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    const h = handler as NotificationHandler;
    set.add(h);
    return () => set!.delete(h);
  }

  onConnectionChange(cb: ConnectionHandler): () => void {
    this.connHandlers.add(cb);
    return () => this.connHandlers.delete(cb);
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      const set = this.handlers.get(msg.method);
      if (set) for (const h of set) h(msg.params as never);
      return;
    }
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const err = msg.error as { message?: string } | undefined;
    if (err) p.reject(new Error(err.message ?? "rpc error"));
    else p.resolve(msg.result);
  }
}
