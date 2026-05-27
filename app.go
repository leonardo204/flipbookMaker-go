// Wails App struct — every method here is exposed to the React frontend via
// the auto-generated `window.go.main.App.*` bindings. The Tauri-compatible
// shim in `frontend/src/shims/tauri/api-core.ts` dispatches `invoke('snake_case')`
// calls to these PascalCase methods.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"flipmd-go/internal/claudecli"
	"flipmd-go/internal/confluence"
	"flipmd-go/internal/credstore"
	"flipmd-go/internal/download"
	"flipmd-go/internal/figma"
	"flipmd-go/internal/fsutil"
	"flipmd-go/internal/nodepath"
	"flipmd-go/internal/pathutil"
	"flipmd-go/internal/runner"
	"flipmd-go/internal/scripts"
	"flipmd-go/internal/updater"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Set via -ldflags at build time. Falls back to a development sentinel.
var appVersion = "0.0.0-dev"

// App is the Wails-bound application state.
type App struct {
	ctx           context.Context
	pendingUpdate *pendingUpdate
}

type pendingUpdate struct {
	version  string
	platform updater.Platform
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	installNativeEditMenu()
	log.Printf("[startup] FlipMD-Go %s", appVersion)
}

// ── env / discovery ─────────────────────────────────────────────────────────

type ClaudeTestResult struct {
	Success bool   `json:"success"`
	Path    string `json:"path,omitempty"`
	Version string `json:"version,omitempty"`
	Message string `json:"message"`
}

func (a *App) TestClaudeCode(customPath string) ClaudeTestResult {
	for _, p := range nodepath.ClaudeCandidates(customPath) {
		out, err := exec.Command(p, "--version").Output()
		if err == nil {
			return ClaudeTestResult{
				Success: true,
				Path:    p,
				Version: strings.TrimSpace(string(out)),
				Message: "Claude Code 연결 성공",
			}
		}
	}
	return ClaudeTestResult{
		Success: false,
		Message: "Claude Code를 찾을 수 없습니다. 설치 후 경로를 지정하세요.",
	}
}

type NodeTestResult struct {
	Available bool   `json:"available"`
	Path      string `json:"path,omitempty"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

func (a *App) TestNodeAvailable() NodeTestResult {
	for _, p := range nodepath.NodeCandidates() {
		out, err := exec.Command(p, "--version").Output()
		if err == nil {
			log.Printf("[test_node_available] found: %s (%s)", p, strings.TrimSpace(string(out)))
			return NodeTestResult{
				Available: true,
				Path:      p,
				Version:   strings.TrimSpace(string(out)),
			}
		}
	}
	return NodeTestResult{
		Available: false,
		Error:     "Node.js를 찾을 수 없습니다. nvm/homebrew/volta로 설치 후 앱을 재시작하세요.",
	}
}

type PlaywrightTestResult struct {
	Available     bool   `json:"available"`
	Version       string `json:"version,omitempty"`
	ModulePath    string `json:"modulePath,omitempty"`
	NpmGlobalRoot string `json:"npmGlobalRoot,omitempty"`
	Error         string `json:"error,omitempty"`
}

func (a *App) TestPlaywrightAvailable() PlaywrightTestResult {
	pwDir, npmRoot := nodepath.FindPlaywrightModule()
	if pwDir != "" {
		version := readPlaywrightVersion(pwDir)
		log.Printf("[test_playwright_available] found: %s (%s)", pwDir, version)
		return PlaywrightTestResult{
			Available:     true,
			Version:       version,
			ModulePath:    pwDir,
			NpmGlobalRoot: npmRoot,
		}
	}
	fallback := ""
	for _, r := range nodepath.NpmGlobalRootCandidates() {
		if pathutil.IsDir(r) {
			fallback = r
			break
		}
	}
	log.Printf("[test_playwright_available] not found. checked: %v", nodepath.NpmGlobalRootCandidates())
	return PlaywrightTestResult{
		Available:     false,
		NpmGlobalRoot: fallback,
		Error:         "Playwright가 글로벌 npm 모듈에 없습니다. 'npm install -g playwright' 후 'npx playwright install chromium' 실행이 필요합니다.",
	}
}

// ── shell / runner ──────────────────────────────────────────────────────────

// RunNodeScript streams stdout lines as "node-progress" events to the frontend.
func (a *App) RunNodeScript(req runner.Request) (runner.Result, error) {
	emit := func(line string) {
		if a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "node-progress", line)
		}
	}
	return runner.RunNode(a.ctx, req, emit)
}

func (a *App) OpenPath(path string) error {
	expanded := pathutil.ExpandTilde(path)
	if !pathutil.Exists(expanded) {
		return fmt.Errorf("파일이 존재하지 않습니다: %s", expanded)
	}
	return openOSPath(expanded)
}

func (a *App) RevealInExplorer(path string) error {
	expanded := pathutil.ExpandTilde(path)
	if !pathutil.Exists(expanded) {
		return fmt.Errorf("파일이 존재하지 않습니다: %s", expanded)
	}
	return revealOSPath(expanded)
}

func (a *App) DownloadToFile(url, destPath string) (int64, error) {
	if url == "" {
		return 0, errors.New("url이 비어있습니다")
	}
	return download.ToFile(a.ctx, url, destPath)
}

// ── credentials ─────────────────────────────────────────────────────────────

func (a *App) SaveCredential(service, key, value string) error {
	return credstore.Save(service, key, value)
}

// LoadCredential returns the password or empty string if absent.
// Frontend Tauri shim expected `Option<String>`; empty string maps to null.
func (a *App) LoadCredential(service, key string) (string, error) {
	return credstore.Load(service, key)
}

func (a *App) DeleteCredential(service, key string) error {
	return credstore.Delete(service, key)
}

// ── confluence ──────────────────────────────────────────────────────────────

func (a *App) TestConfluenceConnection(url, email, token string) (string, error) {
	if err := confluence.TestConnection(a.ctx, confluence.Credentials{
		BaseURL: url,
		Email:   email,
		Token:   token,
	}); err != nil {
		return "", err
	}
	return "연결 성공", nil
}

func (a *App) ConfluenceUploadPage(req confluence.UploadRequest) (confluence.UploadResult, error) {
	return confluence.UploadPage(a.ctx, req)
}

func (a *App) ResolveParentPageId(_baseURL, _email, _token, pageURLOrTitle string) (string, error) {
	id := confluence.ResolveParentPageID(pageURLOrTitle)
	return id, nil
}

// ── figma ───────────────────────────────────────────────────────────────────

func (a *App) FigmaApiProxy(endpoint, token string) (string, error) {
	return figma.Proxy(a.ctx, endpoint, token)
}

// ── claude cli ──────────────────────────────────────────────────────────────

func (a *App) ClaudePrint(req claudecli.Request) (claudecli.Result, error) {
	return claudecli.Print(a.ctx, req)
}

// ── fs ──────────────────────────────────────────────────────────────────────

func (a *App) FsReadTextFile(path string) (string, error) {
	return fsutil.ReadTextFile(path)
}

func (a *App) FsWriteTextFile(path, contents string) error {
	return fsutil.WriteTextFile(path, contents)
}

func (a *App) FsReadDir(path string) ([]fsutil.DirEntry, error) {
	return fsutil.ReadDir(path)
}

func (a *App) FsExists(path string) bool {
	return fsutil.Exists(path)
}

func (a *App) FsRemove(path string) error {
	return fsutil.Remove(path)
}

func (a *App) FsMkdirAll(path string) error {
	return fsutil.MkdirAll(path)
}

// ── path helpers ────────────────────────────────────────────────────────────

func (a *App) HomeDir() string {
	return pathutil.HomeDir()
}

func (a *App) AppDataDir() string {
	if v, err := os.UserConfigDir(); err == nil {
		return filepath.Join(v, "FlipMD")
	}
	return pathutil.HomeDir()
}

func (a *App) ResolveResource(name string) (string, error) {
	return scripts.ResolveResource(name)
}

func (a *App) AppVersion() string { return appVersion }
func (a *App) AppName() string    { return "FlipMD" }

// ReadClipboardText returns the current text on the system pasteboard.
// Called from the frontend Cmd+V handler so the paste path never invokes
// WKWebView's `execCommand('paste')`, which triggers macOS's privacy chip.
func (a *App) ReadClipboardText() (string, error) {
	if a.ctx == nil {
		return "", nil
	}
	return wailsruntime.ClipboardGetText(a.ctx)
}

// ── dialogs ─────────────────────────────────────────────────────────────────

type OpenDialogOptions struct {
	Directory   bool         `json:"directory,omitempty"`
	Multiple    bool         `json:"multiple,omitempty"`
	Title       string       `json:"title,omitempty"`
	DefaultPath string       `json:"defaultPath,omitempty"`
	Filters     []DialogFilt `json:"filters,omitempty"`
}

type DialogFilt struct {
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

type SaveDialogOptions struct {
	Title       string       `json:"title,omitempty"`
	DefaultPath string       `json:"defaultPath,omitempty"`
	Filters     []DialogFilt `json:"filters,omitempty"`
}

type MessageDialogOptions struct {
	Title string `json:"title,omitempty"`
	Kind  string `json:"kind,omitempty"`
}

// OpenDialog returns string, []string or nil — matching the Tauri shim shape.
// Wails JS bridge supports `any` return so the discriminated value is fine.
func (a *App) OpenDialog(opts OpenDialogOptions) (any, error) {
	if a.ctx == nil {
		return nil, errors.New("ctx not ready")
	}
	options := wailsruntime.OpenDialogOptions{
		Title:                opts.Title,
		DefaultDirectory:     pathutil.ExpandTilde(opts.DefaultPath),
		CanCreateDirectories: true,
	}
	for _, f := range opts.Filters {
		options.Filters = append(options.Filters, wailsruntime.FileFilter{
			DisplayName: f.Name,
			Pattern:     joinExtensions(f.Extensions),
		})
	}
	if opts.Directory {
		path, err := wailsruntime.OpenDirectoryDialog(a.ctx, options)
		if err != nil {
			return nil, err
		}
		if path == "" {
			return nil, nil
		}
		return path, nil
	}
	if opts.Multiple {
		paths, err := wailsruntime.OpenMultipleFilesDialog(a.ctx, options)
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, nil
		}
		return paths, nil
	}
	path, err := wailsruntime.OpenFileDialog(a.ctx, options)
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, nil
	}
	return path, nil
}

func (a *App) SaveDialog(opts SaveDialogOptions) (string, error) {
	if a.ctx == nil {
		return "", errors.New("ctx not ready")
	}
	options := wailsruntime.SaveDialogOptions{
		Title:                opts.Title,
		DefaultDirectory:     pathutil.ExpandTilde(opts.DefaultPath),
		CanCreateDirectories: true,
	}
	for _, f := range opts.Filters {
		options.Filters = append(options.Filters, wailsruntime.FileFilter{
			DisplayName: f.Name,
			Pattern:     joinExtensions(f.Extensions),
		})
	}
	return wailsruntime.SaveFileDialog(a.ctx, options)
}

func (a *App) MessageDialog(message string, opts MessageDialogOptions) error {
	if a.ctx == nil {
		return errors.New("ctx not ready")
	}
	dt := wailsruntime.InfoDialog
	switch opts.Kind {
	case "warning":
		dt = wailsruntime.WarningDialog
	case "error":
		dt = wailsruntime.ErrorDialog
	}
	_, err := wailsruntime.MessageDialog(a.ctx, wailsruntime.MessageDialogOptions{
		Type:    dt,
		Title:   opts.Title,
		Message: message,
	})
	return err
}

// ── process / updater ──────────────────────────────────────────────────────

func (a *App) Relaunch() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		if a.ctx != nil {
			wailsruntime.Quit(a.ctx)
		} else {
			os.Exit(0)
		}
	}()
	return nil
}

func (a *App) Exit(code int) {
	os.Exit(code)
}

// UpdateInfo mirrors the shape consumed by the frontend updater shim.
type UpdateInfo struct {
	Version        string `json:"version"`
	CurrentVersion string `json:"currentVersion"`
	Body           string `json:"body,omitempty"`
	Available      bool   `json:"available"`
}

// CheckUpdate downloads the Tauri-format latest.json, picks the entry for
// this OS/arch and stages it for a later download. The staged manifest is
// kept in memory so DownloadAndInstallUpdate can reuse it.
func (a *App) CheckUpdate() (*UpdateInfo, error) {
	if updaterEndpoint == "" || updaterPubKey == "" {
		return &UpdateInfo{
			Version:        appVersion,
			CurrentVersion: appVersion,
			Available:      false,
		}, nil
	}
	manifest, err := updater.FetchManifest(a.ctx, updaterEndpoint)
	if err != nil {
		return nil, err
	}
	key := updater.PlatformKey()
	plat, ok := manifest.Platforms[key]
	if !ok {
		return &UpdateInfo{
			Version:        manifest.Version,
			CurrentVersion: appVersion,
			Available:      false,
			Body:           fmt.Sprintf("이 OS/아키텍처(%s)용 빌드가 manifest에 없습니다", key),
		}, nil
	}
	available := updater.IsNewer(manifest.Version, appVersion)
	if available {
		a.pendingUpdate = &pendingUpdate{
			version:  manifest.Version,
			platform: plat,
		}
	} else {
		a.pendingUpdate = nil
	}
	return &UpdateInfo{
		Version:        manifest.Version,
		CurrentVersion: appVersion,
		Body:           manifest.Notes,
		Available:      available,
	}, nil
}

// DownloadAndInstallUpdate runs the full pipeline for the pending update:
// download -> minisign verify -> extract -> swap via detached helper -> quit.
func (a *App) DownloadAndInstallUpdate() error {
	if a.pendingUpdate == nil {
		return errors.New("스테이징된 업데이트가 없습니다 — 먼저 CheckUpdate를 호출하세요")
	}
	pubkey, err := updater.ParsePublicKey(updaterPubKey)
	if err != nil {
		return fmt.Errorf("pubkey 파싱 실패: %w", err)
	}
	dir, err := updater.DownloadAndExtract(a.ctx, a.pendingUpdate.platform, pubkey)
	if err != nil {
		return err
	}
	if err := updater.SwapAndRelaunch(dir); err != nil {
		return fmt.Errorf("교체 실패: %w", err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		if a.ctx != nil {
			wailsruntime.Quit(a.ctx)
		} else {
			os.Exit(0)
		}
	}()
	return nil
}

// ── helpers ─────────────────────────────────────────────────────────────────

func joinExtensions(exts []string) string {
	if len(exts) == 0 {
		return "*.*"
	}
	parts := make([]string, len(exts))
	for i, e := range exts {
		parts[i] = "*." + strings.TrimPrefix(e, ".")
	}
	return strings.Join(parts, ";")
}
