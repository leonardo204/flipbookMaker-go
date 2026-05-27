package pathutil

import (
	"os"
	"path/filepath"
	"strings"
)

// HomeDir returns the current user's home directory. Empty string if it cannot be determined.
func HomeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	if h := os.Getenv("USERPROFILE"); h != "" {
		return h
	}
	return ""
}

// ExpandTilde resolves a leading `~/` to the user's home directory.
// Returns the input unchanged on non-tilde paths or when home cannot be determined.
func ExpandTilde(p string) string {
	if !strings.HasPrefix(p, "~/") && p != "~" {
		return p
	}
	home := HomeDir()
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	return filepath.Join(home, p[2:])
}

// Exists reports whether a path resolves to an existing filesystem entry.
func Exists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// IsDir reports whether a path resolves to a directory.
func IsDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}
