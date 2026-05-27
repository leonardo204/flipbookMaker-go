import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { resolveResource } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";

export interface ProgressEvent {
  event: string;
  type?: string;
  current?: number;
  total?: number;
  page?: string;
  sitemapPath?: string;
  [key: string]: unknown;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Node.js 설치 여부 확인.
 *
 * macOS GUI 앱은 사용자 shell PATH(nvm/homebrew/volta)를 못 받으므로 Rust 측에 위임.
 * Rust는 ~/.nvm, /opt/homebrew, /usr/local 등 흔한 위치를 직접 검색.
 */
export async function checkNodeAvailable(): Promise<{
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}> {
  try {
    const result = await invoke<{
      available: boolean;
      path: string | null;
      version: string | null;
      error: string | null;
    }>("test_node_available");
    return {
      available: result.available,
      version: result.version ?? undefined,
      path: result.path ?? undefined,
      error: result.error ?? undefined,
    };
  } catch (err) {
    return { available: false, error: String(err) };
  }
}

/**
 * Playwright 글로벌 설치 여부 확인 — Rust 측에 위임 (npm root -g 후 playwright/package.json 검사).
 */
export async function checkPlaywrightAvailable(): Promise<{
  available: boolean;
  version?: string;
  modulePath?: string;
  npmGlobalRoot?: string;
  error?: string;
}> {
  try {
    const result = await invoke<{
      available: boolean;
      version: string | null;
      module_path: string | null;
      npm_global_root: string | null;
      error: string | null;
    }>("test_playwright_available");
    return {
      available: result.available,
      version: result.version ?? undefined,
      modulePath: result.module_path ?? undefined,
      npmGlobalRoot: result.npm_global_root ?? undefined,
      error: result.error ?? undefined,
    };
  } catch (err) {
    return { available: false, error: String(err) };
  }
}

/**
 * Node.js 스크립트 실행 — Rust spawn 위임 + 'node-progress' 이벤트 listen.
 * Tauri shell의 PATH 한계 회피.
 */
async function runScript(
  scriptPath: string,
  args: string[],
  env: Record<string, string>,
  onProgress?: ProgressCallback,
): Promise<void> {
  const unlisten = await listen<string>("node-progress", (event) => {
    const line = event.payload;
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as ProgressEvent;
      onProgress?.(parsed);
    } catch {
      // JSON 아닌 라인은 무시 (디버그 로그 등)
    }
  });

  try {
    const result = await invoke<{ exit_code: number; stderr: string }>(
      "run_node_script",
      {
        request: { script_path: scriptPath, args, env },
      },
    );
    if (result.exit_code !== 0) {
      // stderr 길이 길면 시작 1000자 + 끝 1500자 (총 ~2500자)로 양쪽 보존
      const trimmed = result.stderr.trim();
      let stderrSnippet = trimmed;
      if (trimmed.length > 2500) {
        stderrSnippet =
          trimmed.slice(0, 1000) +
          `\n\n... (${trimmed.length - 2500}자 생략) ...\n\n` +
          trimmed.slice(-1500);
      }
      throw new Error(
        `스크립트 실패 (exit ${result.exit_code})${stderrSnippet ? `\n${stderrSnippet}` : ""}`,
      );
    }
  } finally {
    unlisten();
  }
}

/**
 * crawl.mjs 실행 — Axure Share URL에서 sitemap을 크롤링한다.
 *
 * release .app은 자체 node_modules 없음 → 사용자 글로벌 npm install 필요.
 * Playwright 모듈 경로를 PLAYWRIGHT_MODULE_PATH 환경변수로 crawl.mjs에 전달.
 */
export async function runCrawl(
  url: string,
  outputDir: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  // 1. .app 안 scripts 디렉토리 절대 경로 해석.
  // Tauri는 tauri.conf.json의 resources에 `..`가 포함된 경로를 자동으로
  // `_up_/` 서브디렉토리로 escape함. dev/release에 따라 위치가 다르므로 후보 순회.
  const candidates = [
    "_up_/scripts/crawl.mjs", // release .app: Resources/_up_/scripts/crawl.mjs
    "scripts/crawl.mjs",      // dev 또는 일반적인 resource layout
  ];
  let scriptPath: string | null = null;
  const tried: string[] = [];
  for (const c of candidates) {
    try {
      const resolved = await resolveResource(c);
      tried.push(resolved);
      if (await exists(resolved)) {
        scriptPath = resolved;
        break;
      }
    } catch (e) {
      tried.push(`${c} (resolve error: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (!scriptPath) {
    throw new Error(
      `crawl.mjs 경로를 찾을 수 없습니다. 시도한 경로:\n${tried.join("\n")}`,
    );
  }

  // 2. Playwright 글로벌 위치 확인 + 환경변수로 전달
  const pwResult = await checkPlaywrightAvailable();
  const env: Record<string, string> = {};
  if (pwResult.available && pwResult.modulePath) {
    env["PLAYWRIGHT_MODULE_PATH"] = pwResult.modulePath;
  }

  return runScript(scriptPath, ["--url", url, "--output", outputDir], env, onProgress);
}

