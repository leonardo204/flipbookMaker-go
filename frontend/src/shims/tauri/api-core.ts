// Tauri `invoke(cmd, args)` → Wails App binding 매핑.
// Tauri 시절 snake_case command 이름을 그대로 사용 가능하게 한다.
// 새 backend 메서드를 추가할 때는 여기 매핑 + Go App struct 양쪽을 수정한다.

import { call } from "./runtime";

type Handler = (args: Record<string, unknown> | undefined) => Promise<unknown>;

const get = (
  args: Record<string, unknown> | undefined,
  key: string,
  fallback: unknown = undefined,
): unknown => (args && key in args ? args[key] : fallback);

const handlers: Record<string, Handler> = {
  // ─── env / discovery ─────────────────────────────────────────────
  test_claude_code: (args) =>
    call("TestClaudeCode", (get(args, "customPath", "") as string) ?? ""),
  test_node_available: () => call("TestNodeAvailable"),
  test_playwright_available: () => call("TestPlaywrightAvailable"),

  // ─── shell / fs ──────────────────────────────────────────────────
  open_path: (args) => call("OpenPath", get(args, "path", "") as string),
  run_node_script: (args) => call("RunNodeScript", get(args, "request")),
  download_to_file: (args) =>
    call(
      "DownloadToFile",
      get(args, "url", "") as string,
      get(args, "destPath", "") as string,
    ),

  // ─── credential store ────────────────────────────────────────────
  save_credential: (args) =>
    call(
      "SaveCredential",
      get(args, "service", "") as string,
      get(args, "key", "") as string,
      get(args, "value", "") as string,
    ),
  load_credential: (args) =>
    call(
      "LoadCredential",
      get(args, "service", "") as string,
      get(args, "key", "") as string,
    ),
  delete_credential: (args) =>
    call(
      "DeleteCredential",
      get(args, "service", "") as string,
      get(args, "key", "") as string,
    ),

  // ─── confluence ──────────────────────────────────────────────────
  test_confluence_connection: (args) =>
    call(
      "TestConfluenceConnection",
      get(args, "url", "") as string,
      get(args, "email", "") as string,
      get(args, "token", "") as string,
    ),
  confluence_upload_page: (args) =>
    call("ConfluenceUploadPage", get(args, "request")),
  resolve_parent_page_id: (args) =>
    call(
      "ResolveParentPageId",
      get(args, "baseUrl", "") as string,
      get(args, "email", "") as string,
      get(args, "token", "") as string,
      get(args, "pageUrlOrTitle", "") as string,
    ),

  // ─── figma ───────────────────────────────────────────────────────
  figma_api_proxy: (args) =>
    call(
      "FigmaApiProxy",
      get(args, "endpoint", "") as string,
      get(args, "token", "") as string,
    ),

  // ─── claude cli ──────────────────────────────────────────────────
  claude_print: (args) => call("ClaudePrint", get(args, "request")),
};

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const handler = handlers[command];
  if (!handler) {
    throw new Error(`invoke('${command}'): no Wails handler registered`);
  }
  return (await handler(args)) as T;
}
