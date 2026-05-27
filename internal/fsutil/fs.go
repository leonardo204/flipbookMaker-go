// Package fsutil exposes file operations consumed by the Tauri-compatible
// plugin-fs shim in the frontend.
package fsutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"flipmd-go/internal/pathutil"
)

// DirEntry mirrors the shape expected by frontend `readDir` shim.
type DirEntry struct {
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
	IsFile      bool   `json:"isFile"`
	IsSymlink   bool   `json:"isSymlink"`
}

func ReadTextFile(path string) (string, error) {
	b, err := os.ReadFile(pathutil.ExpandTilde(path))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func WriteTextFile(path, contents string) error {
	expanded := pathutil.ExpandTilde(path)
	if parent := filepath.Dir(expanded); parent != "" {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return err
		}
	}
	return os.WriteFile(expanded, []byte(contents), 0o644)
}

func ReadDir(path string) ([]DirEntry, error) {
	expanded := pathutil.ExpandTilde(path)
	entries, err := os.ReadDir(expanded)
	if err != nil {
		return nil, err
	}
	out := make([]DirEntry, 0, len(entries))
	for _, e := range entries {
		info, _ := e.Info()
		out = append(out, DirEntry{
			Name:        e.Name(),
			IsDirectory: e.IsDir(),
			IsFile:      !e.IsDir() && (info == nil || info.Mode().IsRegular()),
			IsSymlink:   info != nil && info.Mode()&os.ModeSymlink != 0,
		})
	}
	return out, nil
}

func Exists(path string) bool {
	_, err := os.Stat(pathutil.ExpandTilde(path))
	return err == nil
}

func Remove(path string) error {
	expanded := pathutil.ExpandTilde(path)
	if err := os.RemoveAll(expanded); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("삭제 실패: %w (%s)", err, expanded)
	}
	return nil
}

func MkdirAll(path string) error {
	return os.MkdirAll(pathutil.ExpandTilde(path), 0o755)
}
