// Package scripts embeds bundled Node.js helper scripts (crawl.mjs etc.) into
// the binary and extracts them to a per-run temp directory on first access.
package scripts

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

//go:embed all:assets
var bundle embed.FS

var (
	extractOnce sync.Once
	extractDir  string
	extractErr  error
)

// ResolveResource extracts the bundled scripts to a stable temp directory and
// returns the absolute path of the requested resource (e.g. "crawl.mjs").
func ResolveResource(name string) (string, error) {
	if err := ensureExtracted(); err != nil {
		return "", err
	}
	return filepath.Join(extractDir, name), nil
}

// ExtractDir returns the directory where bundled scripts have been written.
func ExtractDir() (string, error) {
	if err := ensureExtracted(); err != nil {
		return "", err
	}
	return extractDir, nil
}

func ensureExtracted() error {
	extractOnce.Do(func() {
		dir, err := os.MkdirTemp("", "flipmd-scripts-*")
		if err != nil {
			extractErr = fmt.Errorf("temp 디렉토리 생성 실패: %w", err)
			return
		}
		extractErr = fs.WalkDir(bundle, "assets", func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel := path[len("assets"):]
			if rel == "" {
				return nil
			}
			target := filepath.Join(dir, rel)
			if d.IsDir() {
				return os.MkdirAll(target, 0o755)
			}
			data, err := bundle.ReadFile(path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			return os.WriteFile(target, data, 0o644)
		})
		if extractErr == nil {
			extractDir = dir
		}
	})
	return extractErr
}
