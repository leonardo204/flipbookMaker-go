// macOS NSMenu intercepts Cmd+C/V/X before the webview sees them and Wails v2
// does not auto-bridge to standard responders. Instead of round-tripping
// clipboard data through Go, the menu callbacks emit an "app-edit" event;
// the React app handles the action via document.execCommand, which the
// WKWebView supports natively (including React-controlled inputs).

package main

import (
	"github.com/wailsapp/wails/v2/pkg/menu"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func emitEdit(a *App, action string) func(*menu.CallbackData) {
	return func(_ *menu.CallbackData) {
		if a.ctx == nil {
			return
		}
		wailsruntime.EventsEmit(a.ctx, "app-edit", action)
	}
}

// pasteFromClipboard reads the system clipboard in Go and pushes the raw text
// to the frontend. WKWebView's `execCommand('paste')` triggers an in-cursor
// "Paste" confirmation chip on macOS for privacy; bypassing it by injecting
// the text directly avoids the extra click.
func pasteFromClipboard(a *App) func(*menu.CallbackData) {
	return func(_ *menu.CallbackData) {
		if a.ctx == nil {
			return
		}
		text, err := wailsruntime.ClipboardGetText(a.ctx)
		if err != nil || text == "" {
			return
		}
		wailsruntime.EventsEmit(a.ctx, "app-paste", text)
	}
}
