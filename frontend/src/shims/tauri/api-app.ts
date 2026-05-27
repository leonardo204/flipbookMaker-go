// Tauri `getVersion()` → Go AppVersion(). 빌드 시 ldflags로 주입한다.

import { call } from "./runtime";

export async function getVersion(): Promise<string> {
  return call<string>("AppVersion");
}

export async function getName(): Promise<string> {
  return call<string>("AppName");
}
