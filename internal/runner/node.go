// Package runner spawns Node.js scripts and streams their stdout to a
// provided emitter (used to forward progress events to the Wails frontend).
package runner

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"sync"

	"flipmd-go/internal/nodepath"
)

// Request mirrors the Tauri-side RunNodeScriptRequest.
type Request struct {
	ScriptPath string            `json:"scriptPath"`
	Args       []string          `json:"args"`
	Env        map[string]string `json:"env,omitempty"`
}

// Result captures exit status and accumulated stderr.
type Result struct {
	ExitCode int    `json:"exitCode"`
	Stderr   string `json:"stderr"`
}

// EmitFunc receives each non-empty stdout line.
type EmitFunc func(line string)

// RunNode resolves the node binary, spawns the script, and emits progress lines.
func RunNode(ctx context.Context, req Request, emit EmitFunc) (Result, error) {
	node := nodepath.ResolveNode()
	if node == "" {
		return Result{}, errors.New("Node.js를 찾을 수 없습니다.")
	}

	log.Printf("[run_node_script] node=%s script=%s args=%v env=%v",
		node, req.ScriptPath, req.Args, req.Env)

	args := append([]string{req.ScriptPath}, req.Args...)
	cmd := exec.CommandContext(ctx, node, args...)
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}
	// inherit PATH, USER, etc. from parent for libraries that need them
	cmd.Env = append(cmd.Env, inheritedEnv()...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, fmt.Errorf("stdout 핸들 실패: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{}, fmt.Errorf("stderr 핸들 실패: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("spawn 실패: %w (node=%s)", err, node)
	}

	var stderrBuf strings.Builder
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if emit != nil {
				emit(line)
			}
		}
	}()

	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			log.Printf("[node stderr] %s", line)
			mu.Lock()
			stderrBuf.WriteString(line)
			stderrBuf.WriteByte('\n')
			mu.Unlock()
		}
	}()

	waitErr := cmd.Wait()
	wg.Wait()

	exit := 0
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exit = ee.ExitCode()
		} else {
			return Result{}, fmt.Errorf("wait 실패: %w", waitErr)
		}
	}

	stderrStr := stderrBuf.String()
	log.Printf("[run_node_script] exit=%d stderr_bytes=%d", exit, len(stderrStr))
	return Result{ExitCode: exit, Stderr: stderrStr}, nil
}
