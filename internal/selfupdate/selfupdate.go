// Package selfupdate provides a stub for the eventual updater pipeline.
// Wails has no built-in updater; the implementation will be ported when the
// release flow is decided (likely GitHub Releases + manual signature check).
package selfupdate

// Info mirrors the shape consumed by the frontend updater shim.
type Info struct {
	Version        string `json:"version"`
	CurrentVersion string `json:"currentVersion"`
	Body           string `json:"body,omitempty"`
	Available      bool   `json:"available"`
}

// Check returns nil today — no update channel is wired yet.
func Check(currentVersion string) (*Info, error) {
	return &Info{
		Version:        currentVersion,
		CurrentVersion: currentVersion,
		Available:      false,
	}, nil
}

// Apply will eventually fetch + verify + replace the binary.
func Apply() error {
	return nil
}
