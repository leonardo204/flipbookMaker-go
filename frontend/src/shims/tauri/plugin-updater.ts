// Tauri updater shim — Wails는 자체 updater가 없으므로 Go selfupdate로 위임.
// 현재 단계: skeleton만 노출, 실 구현은 internal/selfupdate에서.

import { call } from "./runtime";

export type DownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data?: { chunkLength?: number } }
  | { event: "Finished" };

export interface Update {
  version: string;
  currentVersion: string;
  body?: string;
  available: boolean;
  downloadAndInstall(onEvent?: (e: DownloadEvent) => void): Promise<void>;
}

export async function check(): Promise<Update | null> {
  const info = await call<{
    version: string;
    currentVersion: string;
    body?: string;
    available: boolean;
  } | null>("CheckUpdate");
  if (!info || !info.available) return null;
  return {
    ...info,
    async downloadAndInstall(onEvent?: (e: DownloadEvent) => void) {
      onEvent?.({ event: "Started" });
      await call<void>("DownloadAndInstallUpdate");
      onEvent?.({ event: "Finished" });
    },
  };
}
