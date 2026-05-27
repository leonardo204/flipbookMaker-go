import { invoke } from "@tauri-apps/api/core";
import { classifyClaudeErrorPublic } from "./claudeService";

export type SessionStatus = "idle" | "connecting" | "connected" | "busy" | "error";
type StatusListener = (status: SessionStatus) => void;

interface ClaudePrintResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

/**
 * Claude Code headless 세션 관리.
 *
 * 호출은 Rust `claude_print` 명령에 위임 (stdin 기반 → argv overflow 회피).
 * 첫 호출에서 session_id를 캡처하고, 이후 호출에 `--resume <id>`로 컨텍스트 유지.
 */
class ClaudeSession {
  private status: SessionStatus = "idle";
  private sessionId: string | null = null;
  private claudePath: string = "";
  private listeners: StatusListener[] = [];

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  private setStatus(s: SessionStatus) {
    this.status = s;
    this.listeners.forEach(l => l(s));
  }

  getStatus(): SessionStatus { return this.status; }
  getSessionId(): string | null { return this.sessionId; }
  isConnected(): boolean { return this.status === "connected" || this.status === "busy"; }

  async start(claudePath: string): Promise<void> {
    if (this.status === "connecting" || this.status === "connected" || this.status === "busy") return;
    this.setStatus("connecting");
    this.claudePath = claudePath;

    try {
      const result = await this.runClaude("OK", null);
      console.log("[claudeSession] init response:", result.text?.slice(0, 100));
      if (result.sessionId) {
        this.sessionId = result.sessionId;
        this.setStatus("connected");
        console.log("[claudeSession] connected, session:", this.sessionId);
      } else {
        // session_id 없어도 connected로 간주 (--resume 없이 동작)
        this.setStatus("connected");
        console.warn("[claudeSession] connected without session_id (no resume)");
      }
    } catch (e) {
      this.setStatus("error");
      throw e;
    }
  }

  async sendPrompt(prompt: string, timeoutMs = 300000): Promise<string> {
    if (this.status !== "connected") {
      throw new Error(`Claude 세션이 연결되지 않았습니다 (상태: ${this.status})`);
    }
    this.setStatus("busy");
    try {
      // 섹션마다 새 세션으로 호출 — 컨텍스트/이미지 누적 방지.
      // 누적되면 1M context 가까이 차서 image_error로 종료되는 사례 발생.
      // 캐시 효율은 다소 손해지만 안정성 우선.
      const result = await this.runClaude(prompt, null, timeoutMs);
      this.setStatus("connected");
      return result.text || "";
    } catch (e) {
      this.setStatus("connected");
      throw e;
    }
  }

  private async runClaude(
    prompt: string,
    sessionId: string | null,
    timeoutMs = 300000,
  ): Promise<{ text: string; sessionId: string | null }> {
    const promptBytes = prompt.length;
    const timeoutSecs = Math.ceil(timeoutMs / 1000);
    console.log(
      `[claudeSession] runClaude: prompt=${promptBytes} bytes, timeout=${timeoutSecs}s, session=${sessionId ? "resume" : "new"}`,
    );

    const result = await invoke<ClaudePrintResult>("claude_print", {
      request: {
        prompt,
        claude_path: this.claudePath || null,
        session_id: sessionId || null,
        timeout_secs: timeoutSecs,
      },
    });

    if (!result.success) {
      console.error(
        `[claudeSession] FAILED exit=${result.exit_code} elapsed=${result.elapsed_ms}ms`,
      );
      console.error(
        `[claudeSession] stderr (${result.stderr.length} bytes):`,
        result.stderr || "(empty)",
      );
      console.error(
        `[claudeSession] stdout tail:`,
        result.stdout.slice(-500) || "(empty)",
      );

      const detail = classifyClaudeErrorPublic(result, "session");
      throw new Error(detail);
    }

    try {
      const json = JSON.parse(result.stdout.trim());
      return {
        text: json.result || "",
        sessionId: json.session_id || null,
      };
    } catch {
      return { text: result.stdout.trim(), sessionId: null };
    }
  }

  async stop(): Promise<void> {
    this.sessionId = null;
    this.setStatus("idle");
  }
}

export const claudeSession = new ClaudeSession();
