// Tauri plugin-opener → Wails BrowserOpenURL (외부 링크) 또는 Go OpenPath (로컬 경로).

import { call, runtime } from "./runtime";

export async function openUrl(url: string): Promise<void> {
  runtime.openURL(url);
}

export async function openPath(path: string): Promise<void> {
  await call<void>("OpenPath", path);
}

export async function revealItemInDir(path: string): Promise<void> {
  await call<void>("RevealInExplorer", path);
}
