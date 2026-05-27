//go:build !darwin

package main

// No-op on non-macOS — the Wails-built menu drives Cut/Copy/Paste elsewhere.
func installNativeEditMenu() {}
