// Package claudecli spawns the Claude Code CLI using stdin for the prompt to
// avoid argv overflow on large payloads.
package claudecli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"time"

	"flipmd-go/internal/nodepath"
)

const defaultTimeout = 300 * time.Second

// Request mirrors the Tauri-side ClaudePrintRequest payload.
type Request struct {
	Prompt      string `json:"prompt"`
	ClaudePath  string `json:"claudePath,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	TimeoutSecs uint64 `json:"timeoutSecs,omitempty"`
	Cwd         string `json:"cwd,omitempty"`
}

// Result mirrors ClaudePrintResult.
type Result struct {
	Success   bool   `json:"success"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	ElapsedMs uint64 `json:"elapsedMs"`
}

// Print runs `claude -p --output-format json ...` and writes req.Prompt to stdin.
func Print(ctx context.Context, req Request) (Result, error) {
	claudePath := nodepath.ResolveClaude(req.ClaudePath)
	timeout := defaultTimeout
	if req.TimeoutSecs > 0 {
		timeout = time.Duration(req.TimeoutSecs) * time.Second
	}
	started := time.Now()

	log.Printf("[claude_print] path=%s prompt_bytes=%d timeout=%s session=%q",
		claudePath, len(req.Prompt), timeout, req.SessionID)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := []string{
		"-p",
		"--output-format", "json",
		"--dangerously-skip-permissions",
		"--allowedTools", "Read,Write,Bash",
	}
	if req.SessionID != "" {
		args = append(args, "--resume", req.SessionID)
	}

	cmd := exec.CommandContext(runCtx, claudePath, args...)
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Result{}, fmt.Errorf("stdin pipe 실패: %w", err)
	}
	var stdoutBuf, stderrBuf safeBuffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("claude spawn 실패: %w (%s)", err, claudePath)
	}

	if _, err := io.WriteString(stdin, req.Prompt); err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		return Result{}, fmt.Errorf("stdin write 실패: %w", err)
	}
	if err := stdin.Close(); err != nil {
		return Result{}, fmt.Errorf("stdin close 실패: %w", err)
	}

	waitErr := cmd.Wait()
	elapsed := uint64(time.Since(started).Milliseconds())

	if runCtx.Err() == context.DeadlineExceeded {
		return Result{
			Success:   false,
			Stderr:    stderrBuf.String(),
			ExitCode:  -1,
			ElapsedMs: elapsed,
		}, fmt.Errorf("claude 응답 timeout (%ds)", int(timeout.Seconds()))
	}

	exitCode := 0
	success := true
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exitCode = ee.ExitCode()
			success = false
		} else {
			return Result{}, fmt.Errorf("claude wait 실패: %w", waitErr)
		}
	}

	stdout := stdoutBuf.String()
	stderr := stderrBuf.String()

	// Claude Code CLI는 작업을 정상 완료(terminal_reason: completed)하고도 exit
	// code가 0이 아닌 채로 끝나는 경우가 있다. 이때 stdout의 result JSON이
	// completed면 성공으로 보정한다 (없으면 정상 결과가 "비정상 종료"로 오표기됨).
	if !success && completedOK(stdout) {
		log.Printf("[claude_print] exit=%d 이지만 terminal_reason=completed → success 보정", exitCode)
		success = true
	}

	log.Printf("[claude_print] done success=%v exit=%d elapsed=%dms stdout=%dB stderr=%dB",
		success, exitCode, elapsed, len(stdout), len(stderr))

	return Result{
		Success:   success,
		Stdout:    stdout,
		Stderr:    stderr,
		ExitCode:  exitCode,
		ElapsedMs: elapsed,
	}, nil
}

// completedOK는 claude --output-format json의 stdout이 정상 완료
// (terminal_reason: completed, is_error: false)를 나타내는지 검사한다.
// result JSON은 단일 객체이지만, 안전하게 마지막 줄을 우선 파싱한다.
func completedOK(stdout string) bool {
	trimmed := strings.TrimSpace(stdout)
	if trimmed == "" {
		return false
	}
	if idx := strings.LastIndexByte(trimmed, '\n'); idx >= 0 {
		if reasonCompleted(strings.TrimSpace(trimmed[idx+1:])) {
			return true
		}
	}
	return reasonCompleted(trimmed)
}

func reasonCompleted(s string) bool {
	var obj struct {
		TerminalReason string `json:"terminal_reason"`
		IsError        bool   `json:"is_error"`
	}
	if err := json.Unmarshal([]byte(s), &obj); err != nil {
		return false
	}
	return obj.TerminalReason == "completed" && !obj.IsError
}
