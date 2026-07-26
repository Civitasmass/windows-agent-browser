import { AgentBrowserError, errorMessage } from "../errors.js";
import type { CdpErrorPayload, CdpEvent, CdpParams, CdpResponse } from "../types.js";

const CONNECTING = 0;
const OPEN = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CdpWebSocket {
  readonly readyState: number;
  binaryType: BinaryType;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  removeEventListener(type: "open", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "close", listener: (event: CloseEvent) => void): void;
}

export type CdpWebSocketFactory = (url: string) => CdpWebSocket;
export type CdpEventListener<T = unknown> = (event: CdpEvent<T>) => void;

export interface CdpClientOptions {
  webSocketFactory?: CdpWebSocketFactory;
  defaultTimeoutMs?: number;
  connectTimeoutMs?: number;
  onListenerError?: (error: unknown, event: CdpEvent) => void;
}

export interface WaitForEventOptions<T = unknown> {
  sessionId?: string;
  predicate?: (event: CdpEvent<T>) => boolean;
  timeoutMs?: number;
}

interface PendingCommand {
  readonly method: string;
  readonly sessionId?: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  reject(error: Error): void;
}

export class CdpProtocolError extends AgentBrowserError {
  readonly method: string;
  readonly cdpCode: number;
  readonly data?: string;
  readonly sessionId?: string;

  constructor(method: string, payload: CdpErrorPayload, sessionId?: string) {
    const suffix = payload.data ? ` (${payload.data})` : "";
    super(
      "CDP_PROTOCOL_ERROR",
      `CDP ${method} failed [${payload.code}]: ${payload.message}${suffix}`,
    );
    this.name = "CdpProtocolError";
    this.method = method;
    this.cdpCode = payload.code;
    if (payload.data !== undefined) this.data = payload.data;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

export class CdpTimeoutError extends AgentBrowserError {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly sessionId?: string;

  constructor(operation: string, timeoutMs: number, sessionId?: string) {
    super(
      "CDP_TIMEOUT",
      `CDP ${operation} timed out after ${timeoutMs}ms`,
    );
    this.name = "CdpTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

export class CdpConnectionError extends AgentBrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super("CDP_CONNECTION_ERROR", message, options);
    this.name = "CdpConnectionError";
  }
}

function defaultWebSocketFactory(url: string): CdpWebSocket {
  if (typeof globalThis.WebSocket !== "function") {
    throw new CdpConnectionError(
      "The Node.js WebSocket global is unavailable; Node.js 22 or newer is required",
    );
  }

  return new globalThis.WebSocket(url) as CdpWebSocket;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function validateWebSocketUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new CdpConnectionError(`Invalid browser WebSocket URL: ${url}`, {
      cause,
    });
  }

  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new CdpConnectionError(
      `Browser WebSocket URL must use ws: or wss:, received ${parsed.protocol}`,
    );
  }
  return parsed.href;
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text();
  }
  throw new TypeError(`Unsupported WebSocket message type: ${typeof data}`);
}

function closeDescription(event: CloseEvent): string {
  const reason = event.reason ? `: ${event.reason}` : "";
  return `CDP WebSocket closed (${event.code})${reason}`;
}

/**
 * A dependency-free client for the browser-level Chrome DevTools Protocol
 * WebSocket. Target sessions use CDP's flattened `sessionId` envelope.
 */
export class CdpClient {
  private readonly webSocketFactory: CdpWebSocketFactory;
  private readonly defaultTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly onListenerError: (error: unknown, event: CdpEvent) => void;
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventWaiters = new Set<EventWaiter>();

  private socket?: CdpWebSocket;
  private socketUrl?: string;
  private connectPromise?: Promise<void>;
  private nextId = 1;
  private explicitlyClosed = false;
  private terminalError?: Error;

  constructor(options: CdpClientOptions = {}) {
    this.webSocketFactory =
      options.webSocketFactory ?? defaultWebSocketFactory;
    this.defaultTimeoutMs = positiveTimeout(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    this.connectTimeoutMs = positiveTimeout(
      options.connectTimeoutMs ?? this.defaultTimeoutMs,
      "connectTimeoutMs",
    );
    this.onListenerError =
      options.onListenerError ??
      ((error, event) => {
        process.emitWarning(errorMessage(error), {
          code: "CDP_EVENT_LISTENER_ERROR",
          detail: `Listener for ${event.method} failed`,
        });
      });
  }

  static async connect(
    url: string,
    options: CdpClientOptions = {},
  ): Promise<CdpClient> {
    const client = new CdpClient(options);
    await client.connect(url);
    return client;
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN;
  }

  get url(): string | undefined {
    return this.socketUrl;
  }

  /**
   * Connects once. Repeating the same URL is idempotent; trying a different
   * endpoint with the same client is an error.
   */
  connect(url: string): Promise<void> {
    const normalizedUrl = validateWebSocketUrl(url);

    if (this.explicitlyClosed) {
      return Promise.reject(
        new CdpConnectionError("Cannot connect a closed CDP client"),
      );
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.socketUrl && this.socketUrl !== normalizedUrl) {
      return Promise.reject(
        new CdpConnectionError(
          `CDP client is already bound to ${this.socketUrl}; create a new client for ${normalizedUrl}`,
        ),
      );
    }
    if (this.socket?.readyState === OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    let socket: CdpWebSocket;
    try {
      socket = this.webSocketFactory(normalizedUrl);
      socket.binaryType = "arraybuffer";
    } catch (cause) {
      return Promise.reject(
        cause instanceof CdpConnectionError
          ? cause
          : new CdpConnectionError(
              `Failed to create CDP WebSocket for ${normalizedUrl}: ${errorMessage(cause)}`,
              { cause },
            ),
      );
    }

    this.socket = socket;
    this.socketUrl = normalizedUrl;

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = (): void => finish();
      const timer = setTimeout(() => {
        const error = new CdpTimeoutError(
          "WebSocket connection",
          this.connectTimeoutMs,
        );
        finish(error);
        this.terminateSocket(socket, error, 1000);
      }, this.connectTimeoutMs);

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", (event) => {
        void this.handleMessage(socket, event.data).catch((cause: unknown) => {
          const error = new CdpConnectionError(
            `Invalid CDP WebSocket message: ${errorMessage(cause)}`,
            { cause },
          );
          this.terminateSocket(socket, error, 1002);
        });
      });
      socket.addEventListener("error", () => {
        const error = new CdpConnectionError(
          `CDP WebSocket error for ${normalizedUrl}`,
        );
        finish(error);
        this.terminateSocket(socket, error, 1011);
      });
      socket.addEventListener("close", (event) => {
        const error = new CdpConnectionError(closeDescription(event));
        finish(error);
        this.terminalError ??= error;
        this.rejectOutstanding(error);
        this.listeners.clear();
      });
    });

    this.connectPromise = promise;
    void promise.catch(() => {
      // Preserve the rejected promise for idempotent callers.
    });
    return promise;
  }

  /**
   * Sends a CDP command. Passing `sessionId` emits the flattened target-session
   * envelope supported by browser-level WebSocket connections.
   */
  send<T = unknown>(
    method: string,
    params?: CdpParams,
    sessionId?: string,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    if (!method) {
      return Promise.reject(new TypeError("CDP method must not be empty"));
    }
    positiveTimeout(timeoutMs, "timeoutMs");

    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return Promise.reject(
        this.terminalError ??
          new CdpConnectionError("CDP WebSocket is not connected"),
      );
    }

    const id = this.nextId++;
    const request: Record<string, unknown> = { id, method };
    if (params !== undefined) request.params = params;
    if (sessionId !== undefined) request.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs, sessionId));
      }, timeoutMs);

      const pending: PendingCommand = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
      this.pending.set(id, pending);

      try {
        socket.send(JSON.stringify(request));
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new CdpConnectionError(
            `Failed to send CDP ${method}: ${errorMessage(cause)}`,
            { cause },
          ),
        );
      }
    });
  }

  on<T = unknown>(
    method: string,
    listener: CdpEventListener<T>,
  ): () => void {
    if (!method) throw new TypeError("CDP event method must not be empty");

    let methodListeners = this.listeners.get(method);
    if (!methodListeners) {
      methodListeners = new Set();
      this.listeners.set(method, methodListeners);
    }
    methodListeners.add(listener as CdpEventListener);

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      methodListeners.delete(listener as CdpEventListener);
      if (methodListeners.size === 0) this.listeners.delete(method);
    };
  }

  once<T = unknown>(
    method: string,
    listener: CdpEventListener<T>,
  ): () => void {
    let unsubscribe = (): void => {};
    unsubscribe = this.on<T>(method, (event) => {
      unsubscribe();
      listener(event);
    });
    return unsubscribe;
  }

  waitForEvent<T = unknown>(
    method: string,
    options: WaitForEventOptions<T> = {},
  ): Promise<CdpEvent<T>> {
    const timeoutMs = positiveTimeout(
      options.timeoutMs ?? this.defaultTimeoutMs,
      "timeoutMs",
    );
    if (
      this.explicitlyClosed ||
      this.terminalError ||
      !this.socket ||
      (this.socket.readyState !== CONNECTING &&
        this.socket.readyState !== OPEN)
    ) {
      return Promise.reject(
        this.terminalError ??
          new CdpConnectionError(
            "Cannot wait for an event before the CDP client is connected",
          ),
      );
    }

    return new Promise<CdpEvent<T>>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let unsubscribe = (): void => {};

      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.eventWaiters.delete(waiter);
      };
      const waiter: EventWaiter = {
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };

      unsubscribe = this.on<T>(method, (event) => {
        if (
          options.sessionId !== undefined &&
          event.sessionId !== options.sessionId
        ) {
          return;
        }

        let matches = true;
        try {
          matches = options.predicate?.(event) ?? true;
        } catch (cause) {
          cleanup();
          reject(
            cause instanceof Error
              ? cause
              : new Error(`CDP event predicate failed: ${String(cause)}`),
          );
          return;
        }
        if (!matches) return;

        cleanup();
        resolve(event);
      });
      timer = setTimeout(() => {
        cleanup();
        reject(
          new CdpTimeoutError(`event ${method}`, timeoutMs, options.sessionId),
        );
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  close(code = 1000, reason = "Client closed"): void {
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;

    const error = new CdpConnectionError("CDP client closed");
    this.terminalError = error;
    this.rejectOutstanding(error);
    this.listeners.clear();

    const socket = this.socket;
    if (
      socket &&
      (socket.readyState === CONNECTING || socket.readyState === OPEN)
    ) {
      socket.close(code, reason);
    }
  }

  private async handleMessage(
    source: CdpWebSocket,
    data: unknown,
  ): Promise<void> {
    if (source !== this.socket) return;

    const text = await messageText(data);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("CDP message must be a JSON object");
    }

    const message = parsed as Record<string, unknown>;
    if (typeof message.id === "number") {
      this.handleResponse(message as unknown as CdpResponse);
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = { method: message.method };
      if ("params" in message) {
        Object.assign(event, { params: message.params });
      }
      if (typeof message.sessionId === "string") {
        Object.assign(event, { sessionId: message.sessionId });
      }
      this.dispatch(event);
      return;
    }

    throw new TypeError("CDP message has neither a numeric id nor a method");
  }

  private handleResponse(response: CdpResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(
        new CdpProtocolError(
          pending.method,
          response.error,
          pending.sessionId,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private dispatch(event: CdpEvent): void {
    const methodListeners = this.listeners.get(event.method);
    if (!methodListeners) return;

    for (const listener of [...methodListeners]) {
      try {
        listener(event);
      } catch (cause) {
        this.onListenerError(cause, event);
      }
    }
  }

  private terminateSocket(
    source: CdpWebSocket,
    error: Error,
    closeCode: number,
  ): void {
    if (source !== this.socket) return;
    this.terminalError ??= error;
    this.rejectOutstanding(error);
    this.listeners.clear();
    if (source.readyState === CONNECTING || source.readyState === OPEN) {
      source.close(closeCode, "CDP protocol error");
    }
  }

  private rejectOutstanding(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    for (const waiter of [...this.eventWaiters]) {
      waiter.reject(error);
    }
  }
}
