// Package nodepath discovers Node.js, npm-global, Playwright, and Claude CLI
// installation paths across macOS and Windows. GUI apps don't inherit the user's
// shell PATH on macOS, so well-known install locations are searched directly.
package nodepath

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"flipmd-go/internal/pathutil"
)

// NodeCandidates returns a prioritised list of node executable paths to try.
func NodeCandidates() []string {
	var out []string
	home := pathutil.HomeDir()

	if home != "" {
		out = append(out, sortedNvmBins(home, nodeExec())...)
		volta := filepath.Join(home, ".volta", "bin", nodeExec())
		if pathutil.Exists(volta) {
			out = append(out, volta)
		}
		fnm := filepath.Join(home, ".fnm", "aliases", "default", "bin", nodeExec())
		if pathutil.Exists(fnm) {
			out = append(out, fnm)
		}
	}

	out = append(out, osNodeCandidates(home)...)
	out = append(out, nodeExec())
	return out
}

// ClaudeCandidates returns candidate paths for the Claude Code CLI.
func ClaudeCandidates(custom string) []string {
	if custom = strings.TrimSpace(custom); custom != "" {
		return []string{pathutil.ExpandTilde(custom)}
	}

	var out []string
	home := pathutil.HomeDir()

	if home != "" {
		out = append(out, filepath.Join(home, ".local", "bin", claudeExec()))
		out = append(out, sortedNvmBins(home, claudeExec())...)
		volta := filepath.Join(home, ".volta", "bin", claudeExec())
		if pathutil.Exists(volta) {
			out = append(out, volta)
		}
	}

	out = append(out, osClaudeCandidates()...)
	out = append(out, claudeExec())
	return out
}

// NpmGlobalRootCandidates returns directories where global npm modules may live.
func NpmGlobalRootCandidates() []string {
	var out []string
	home := pathutil.HomeDir()

	if home != "" {
		nvmRoot := filepath.Join(home, ".nvm", "versions", "node")
		if entries, err := os.ReadDir(nvmRoot); err == nil {
			versions := filterDirs(entries)
			sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
			for i := len(versions) - 1; i >= 0; i-- {
				out = append(out, filepath.Join(nvmRoot, versions[i], "lib", "node_modules"))
			}
		}
		out = append(out,
			filepath.Join(home, ".npm-global", "lib", "node_modules"),
			filepath.Join(home, ".npm", "lib", "node_modules"),
			filepath.Join(home, ".volta", "tools", "image", "packages"),
		)
	}

	out = append(out, osNpmGlobalRootCandidates(home)...)
	return out
}

// FindPlaywrightModule searches global npm roots for a `playwright` package.
// Returns the package directory and its containing npm root, or "" on failure.
func FindPlaywrightModule() (moduleDir string, npmRoot string) {
	for _, root := range NpmGlobalRootCandidates() {
		dir := filepath.Join(root, "playwright")
		if pathutil.Exists(filepath.Join(dir, "package.json")) {
			return dir, root
		}
	}
	return "", ""
}

// ResolveNode returns the absolute path of the first node executable that
// answers `--version` successfully. Empty string on failure.
func ResolveNode() string {
	for _, p := range NodeCandidates() {
		if cmd := exec.Command(p, "--version"); cmd.Run() == nil {
			return p
		}
	}
	if p := whichCommand("node"); p != "" {
		if cmd := exec.Command(p, "--version"); cmd.Run() == nil {
			return p
		}
	}
	return ""
}

// ResolveClaude mirrors ResolveNode for the Claude CLI. Falls back to the bare
// command name so PATH lookup can take over at spawn time.
func ResolveClaude(custom string) string {
	for _, p := range ClaudeCandidates(custom) {
		if pathutil.Exists(p) {
			return p
		}
	}
	// PATH 기반 탐색 — Wails GUI 앱은 일부 환경에서 사용자 PATH를 못 받기 때문에
	// 시스템 도구(where.exe / which)를 통해 한 번 더 시도한다.
	if p := whichCommand("claude"); p != "" {
		return p
	}
	return claudeExec()
}

func sortedNvmBins(home, leaf string) []string {
	root := filepath.Join(home, ".nvm", "versions", "node")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	versions := filterDirs(entries)
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	var out []string
	for i := len(versions) - 1; i >= 0; i-- {
		bin := filepath.Join(root, versions[i], "bin", leaf)
		if pathutil.Exists(bin) {
			out = append(out, bin)
		}
	}
	return out
}

func filterDirs(entries []os.DirEntry) []string {
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}

func nodeExec() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func claudeExec() string {
	if runtime.GOOS == "windows" {
		return "claude.cmd"
	}
	return "claude"
}
