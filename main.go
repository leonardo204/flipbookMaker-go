package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// 자동 업데이트는 leonardo204/flipbookMaker-go GitHub Releases에서 발행되는
// latest.json + minisign 서명을 검증한다. minisign 키쌍은 Tauri 시절(원본
// flipbookMaker)에 만든 것을 그대로 재사용한다 — pubkey 동일.
var (
	updaterEndpoint = "https://github.com/leonardo204/flipbookMaker-go/releases/latest/download/latest.json"
	updaterPubKey   = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhEMDgwMDk5NjY2ODAyQzkKUldUSkFtaG1tUUFJalhXbG1JQmhuU0l1Z2FHSFFMT3NHcndzRklDU2ljWjhkMzBmQmVUUUdnMXIK"
)

func main() {
	app := NewApp()

	appMenu := buildMenu(app)

	err := wails.Run(&options.App{
		Title:             "FlipMD",
		Width:             1000,
		Height:            900,
		MinWidth:          1000,
		MinHeight:         900,
		MaxWidth:          1000,
		MaxHeight:         900,
		DisableResize:     true,
		Menu:              appMenu,
		AssetServer:       &assetserver.Options{Assets: assets},
		BackgroundColour:  &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:         app.startup,
		Bind:              []interface{}{app},
		Mac: &mac.Options{
			TitleBar:             mac.TitleBarDefault(),
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			About: &mac.AboutInfo{
				Title:   "FlipMD",
				Message: "FlipMD — Figma/Axshare flipbook to Markdown to Confluence",
			},
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
	})

	if err != nil {
		log.Fatalf("wails run error: %v", err)
	}
}

// buildMenu mirrors the App / Edit / Window menus from the Tauri app and
// emits a "navigate" event when "Settings…" is selected, matching the
// frontend's existing router listener.
func buildMenu(a *App) *menu.Menu {
	root := menu.NewMenu()

	appMenu := root.AddSubmenu("FlipMD")
	appMenu.AddText("About FlipMD", nil, func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wailsruntime.MessageDialog(a.ctx, wailsruntime.MessageDialogOptions{
				Type:    wailsruntime.InfoDialog,
				Title:   "About FlipMD",
				Message: "FlipMD " + appVersion,
			})
		}
	})
	appMenu.AddSeparator()
	appMenu.AddText("Settings…", keys.CmdOrCtrl(","), func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "navigate", "/settings")
		}
	})
	appMenu.AddSeparator()
	appMenu.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wailsruntime.Quit(a.ctx)
		}
	})

	// Edit 메뉴는 startup 직후 native_menu_darwin.m이 표준 NSResponder selector
	// (undo:/redo:/cut:/copy:/paste:/selectAll:)로 다시 그린다. Wails로 만들면
	// callback wrapper가 끼어들어 (a) 시스템 "Paste" 확인 칩이 뜨고 (b)
	// keydown 가로채기 우회 코드가 IME 모니터링을 가린다. 위치를 잡기 위해
	// 자리만 만들어 둔다 — 내용은 cgo 측에서 교체.
	root.AddSubmenu("Edit")

	winMenu := root.AddSubmenu("Window")
	winMenu.AddText("Minimize", keys.CmdOrCtrl("m"), func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wailsruntime.WindowMinimise(a.ctx)
		}
	})
	winMenu.AddText("Close", keys.CmdOrCtrl("w"), func(_ *menu.CallbackData) {
		if a.ctx != nil {
			wailsruntime.WindowHide(a.ctx)
		}
	})

	return root
}
