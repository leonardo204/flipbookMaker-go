// Tauri plugin-process — Wails는 자체 relaunch가 없어 Go에서 spawn+quit으로 처리.

import { call, runtime } from "./runtime";

export async function relaunch(): Promise<void> {
  await call<void>("Relaunch");
}

export async function exit(code: number = 0): Promise<void> {
  if (code === 0) {
    runtime.quit();
    return;
  }
  await call<void>("Exit", code);
}
