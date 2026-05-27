// Tauri path helpers → Go App 메서드 위임. embed.FS 리소스는 ResolveResource로 매핑.

import { call } from "./runtime";

export async function homeDir(): Promise<string> {
  return call<string>("HomeDir");
}

export async function appDataDir(): Promise<string> {
  return call<string>("AppDataDir");
}

export async function resolveResource(name: string): Promise<string> {
  return call<string>("ResolveResource", name);
}
