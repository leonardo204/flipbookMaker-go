// Package claudecli spawns the Claude Code CLI using stdin for the prompt to
// avoid argv overflow on large payloads.
package claudecli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
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
