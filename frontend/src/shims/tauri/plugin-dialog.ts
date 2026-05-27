// Tauri plugin-dialog → Wails runtime dialog 호출은 Go 측 OpenDialog 메서드로 위임.

import { call } from "./runtime";

export interface OpenDialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function open(
  options: OpenDialogOptions = {},
): Promise<string | string[] | null> {
  const result = await call<string | string[] | null>("OpenDialog", options);
  return result ?? null;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export async function save(
  options: SaveDialogOptions = {},
): Promise<string | null> {
  const result = await call<string | null>("SaveDialog", options);
  return result || null;
}

export interface MessageDialogOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
}

export async function message(text: string, options: MessageDialogOptions = {}): Promise<void> {
  await call<void>("MessageDialog", text, options);
}
