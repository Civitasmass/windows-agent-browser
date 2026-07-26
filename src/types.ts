export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type CdpParams = Record<string, unknown>;

export interface CdpErrorPayload {
  code: number;
  message: string;
  data?: string;
}

export interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: CdpErrorPayload;
  sessionId?: string;
}

export interface CdpEvent<T = unknown> {
  method: string;
  params?: T;
  sessionId?: string;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
  browserContextId?: string;
}

export interface AttachedTarget {
  targetId: string;
  sessionId: string;
}

export interface BrowserPaths {
  appDir: string;
  profileDir: string;
  stateDir: string;
  activeTargetFile: string;
  refsFile: string;
  browserPidFile: string;
}

export interface BrowserConfig {
  executablePath: string;
  paths: BrowserPaths;
  contextName: string;
  launchTimeoutMs: number;
  cdpTimeoutMs: number;
}
