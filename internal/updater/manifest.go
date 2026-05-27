// Package updater implements Tauri-compatible self-update: fetch latest.json,
// verify minisign Ed25519 signature, download .app.tar.gz, replace and
// relaunch. The pubkey + endpoint constants are wired in main and passed in
// so this package stays independent of release-specific configuration.
package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Platform mirrors the per-OS entry in Tauri's latest.json.
type Platform struct {
	Signature string `json:"signature"`
	URL       string `json:"url"`
}

// Manifest is the top-level latest.json document.
type Manifest struct {
	Version   string              `json:"version"`
	Notes     string              `json:"notes,omitempty"`
	PubDate   time.Time           `json:"pub_date,omitempty"`
	Platforms map[string]Platform `json:"platforms"`
}

// FetchManifest downloads and parses latest.json from the given endpoint.
func FetchManifest(ctx context.Context, endpoint string) (*Manifest, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("updater endpoint가 비어있습니다")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("manifest 다운로드 실패: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("manifest HTTP %d: %s", resp.StatusCode, string(body))
	}
	var m Manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, fmt.Errorf("manifest 파싱 실패: %w", err)
	}
	return &m, nil
}

// PlatformKey returns the Tauri-compatible OS/arch key (darwin-aarch64, ...).
// On Windows, portable distributions get a "-portable" suffix so the same
// latest.json can carry both installer and portable assets side by side.
func PlatformKey() string {
	switch runtime.GOOS {
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "darwin-aarch64"
		}
		return "darwin-x86_64"
	case "windows":
		base := "windows-x86_64"
		if runtime.GOARCH == "arm64" {
			base = "windows-aarch64"
		}
		if IsPortable() {
			return base + "-portable"
		}
		return base
	case "linux":
		if runtime.GOARCH == "arm64" {
			return "linux-aarch64"
		}
		return "linux-x86_64"
	}
	return ""
}

// IsPortable returns true when the running executable is not installed under
// the standard %ProgramFiles% locations on Windows. macOS always returns false
// (the .app bundle path itself is the unit of update).
func IsPortable() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return true
	}
	exe = strings.ToLower(filepath.Clean(exe))
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		base := os.Getenv(env)
		if base == "" {
			continue
		}
		if strings.HasPrefix(exe, strings.ToLower(filepath.Clean(base))+string(filepath.Separator)) {
			return false
		}
	}
	return true
}

// IsNewer returns true when remote is strictly greater than current using
// a simple dotted-numeric compare (Tauri-style "1.3.10" semantics, no semver
// pre-release suffix handling — Tauri's release flow doesn't emit those).
func IsNewer(remote, current string) bool {
	a := splitDigits(remote)
	b := splitDigits(current)
	n := len(a)
	if len(b) > n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		ai, bi := at(a, i), at(b, i)
		if ai > bi {
			return true
		}
		if ai < bi {
			return false
		}
	}
	return false
}

func splitDigits(v string) []int {
	out := []int{0}
	cur := 0
	started := false
	for _, c := range v {
		if c >= '0' && c <= '9' {
			cur = cur*10 + int(c-'0')
			started = true
			continue
		}
		if started {
			out[len(out)-1] = cur
			out = append(out, 0)
			cur = 0
			started = false
		}
	}
	if started {
		out[len(out)-1] = cur
	}
	return out
}

func at(v []int, i int) int {
	if i >= len(v) {
		return 0
	}
	return v[i]
}
