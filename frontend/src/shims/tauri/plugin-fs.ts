// Tauri plugin-fs → Go backend 매핑. Wails 자체 fs 플러그인이 없으므로 직접 노출.

import { call } from "./runtime";

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink?: boolean;
}

export async function readTextFile(path: string): Promise<string> {
  return call<string>("FsReadTextFile", path);
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await call<void>("FsWriteTextFile", path, contents);
}

export async function readDir(path: string): Promise<DirEntry[]> {
  return call<DirEntry[]>("FsReadDir", path);
}

export async function exists(path: string): Promise<boolean> {
  return call<boolean>("FsExists", path);
}

export async function remove(path: string): Promise<void> {
  await call<void>("FsRemove", path);
}

export async function mkdir(path: string, _opts?: { recursive?: boolean }): Promise<void> {
  await call<void>("FsMkdirAll", path);
}
