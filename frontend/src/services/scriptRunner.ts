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
    // Go(app.go PlaywrightTestResult) json 태그는 camelCase(modulePath/
    // npmGlobalRoot). Wails 바인딩은 키를 그대로 전달하므로 camelCase로 읽어야 한다.
    const result = await invoke<{
      available: boolean;
      version: string | null;
      modulePath: string | null;
      npmGlobalRoot: string | null;
      error: string | null;
    }>("test_playwright_available");
    return {
      available: result.available,
      version: result.version ?? undefined,
      modulePath: result.modulePath ?? undefined,
      npmGlobalRoot: result.npmGlobalRoot ?? undefined,
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
    // Go(runner.Result) json 태그는 camelCase(exitCode). Wails 바인딩은 키를
    // 그대로 전달하므로 camelCase로 읽어야 한다. 과거 exit_code로 읽어 항상
    // undefined → 성공(exit 0)에도 "스크립트 실패 (exit undefined)"로 오판정했음.
    const result = await invoke<{ exitCode: number; stderr: string }>(
      "run_node_script",
      {
        // Go(runner.Request) json 태그도 camelCase(scriptPath). snake_case로
        // 보내면 매칭 안 돼 ScriptPath가 빈 값이 되어 node가 빈 경로로 spawn됨.
        request: { scriptPath, args, env },
      },
    );
    if (result.exitCode !== 0) {
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
        `스크립트 실패 (exit ${result.exitCode})${stderrSnippet ? `\n${stderrSnippet}` : ""}`,
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
  // 1. crawl.mjs 절대 경로 해석.
  // Wails 포팅: Go의 internal/scripts/embed.go가 embed.FS(`assets/*`)를 임시
  // 디렉토리에 풀 때 `assets` prefix를 벗겨 `extractDir/crawl.mjs`(루트)에 둔다.
  // ResolveResource(name)은 extractDir와 join하므로 name은 `crawl.mjs`여야 한다.
  // 뒤 두 후보는 구 Tauri resource 레이아웃(`..`→`_up_/` escape) 하위 호환용 fallback.
  const candidates = [
    "crawl.mjs",              // Wails: extractDir/crawl.mjs (실제 embed 레이아웃)
    "_up_/scripts/crawl.mjs", // 레거시 Tauri .app: Resources/_up_/scripts/crawl.mjs
    "scripts/crawl.mjs",      // 레거시 dev resource layout
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

