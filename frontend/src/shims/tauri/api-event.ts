// Tauri `listen(event, cb)` → Wails `EventsOn` 매핑.
// 반환값은 unlisten 함수 (Tauri 호환).

import { runtime } from "./runtime";

export interface Event<T> {
  event: string;
  payload: T;
}

export type UnlistenFn = () => void;

export async function listen<T = unknown>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  const off = runtime.on(event, (...payload: unknown[]) => {
    const value = (payload.length <= 1 ? payload[0] : payload) as T;
    handler({ event, payload: value });
  });
  return off;
}

export async function once<T = unknown>(
  event: string,
  handler: (e: Event<T>) => void,
): Promise<UnlistenFn> {
  const off = await listen<T>(event, (e) => {
    off();
    handler(e);
  });
  return off;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  runtime.emit(event, payload);
}
