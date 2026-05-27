// Wails v2 runtime bridge — Tauri 호환 shim의 공통 의존성.
// Wails는 빌드/dev 시 window.go.main.App.{Method} 와 window.runtime.* 를 자동 주입.
// 단위 테스트(vitest)나 SSR 환경에서는 window가 없으므로 안전한 fallback 제공.

type AnyFn = (...args: unknown[]) => Promise<unknown> | unknown;

interface WailsApp {
  [method: string]: AnyFn;
}

interface WailsRuntime {
  EventsOn(eventName: string, callback: (...payload: unknown[]) => void): () => void;
  EventsOff(eventName: string): void;
  EventsEmit(eventName: string, ...payload: unknown[]): void;
  BrowserOpenURL(url: string): void;
  Environment(): Promise<{ buildType: string; platform: string; arch: string }>;
  Quit(): void;
  WindowReloadApp(): void;
}

declare global {
  interface Window {
    go?: { main?: { App?: WailsApp } };
    runtime?: WailsRuntime;
  }
}

const NOT_READY = "Wails runtime is not initialised yet";

function ensureApp(): WailsApp {
  const app = typeof window !== "undefined" ? window.go?.main?.App : undefined;
  if (!app) throw new Error(NOT_READY);
  return app;
}

function ensureRuntime(): WailsRuntime {
  const rt = typeof window !== "undefined" ? window.runtime : undefined;
  if (!rt) throw new Error(NOT_READY);
  return rt;
}

export async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const app = ensureApp();
  const fn = app[method];
  if (typeof fn !== "function") {
    throw new Error(`Wails binding not found: main.App.${method}`);
  }
  return (await fn(...args)) as T;
}

export const runtime = {
  on(event: string, cb: (...payload: unknown[]) => void): () => void {
    return ensureRuntime().EventsOn(event, cb);
  },
  off(event: string): void {
    ensureRuntime().EventsOff(event);
  },
  emit(event: string, ...payload: unknown[]): void {
    ensureRuntime().EventsEmit(event, ...payload);
  },
  openURL(url: string): void {
    ensureRuntime().BrowserOpenURL(url);
  },
  quit(): void {
    ensureRuntime().Quit();
  },
  reload(): void {
    ensureRuntime().WindowReloadApp();
  },
};

// callApp exposes the raw Wails App binding for callers that need direct
// access (e.g. the Cmd+V keydown handler that must run synchronously without
// the Tauri invoke() detour).
export function callApp<T>(method: string, ...args: unknown[]): Promise<T> {
  return call<T>(method, ...args);
}
