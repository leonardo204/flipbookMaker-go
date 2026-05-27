//go:build windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// SwapAndRelaunch on Windows handles two asset shapes:
//
//   1. NSIS installer (".nsis.zip" → unpacked ".exe" with the "installer"
//      substring or no matching portable target). Spawned with /S silent
//      flag; the NSIS template re-launches the freshly installed app.
//   2. Portable zip (".zip" containing just FlipMD.exe). The currently
//      running .exe cannot overwrite itself, so a PowerShell helper waits
//      for our PID to exit and then swaps the file + relaunches.
func SwapAndRelaunch(extractedDir string) error {
	info, err := os.Stat(extractedDir)
	if err != nil {
		return fmt.Errorf("자산 확인 실패: %w", err)
	}

	target := extractedDir
	if info.IsDir() {
		// Prefer an installer-looking exe over a portable one when both
		// happen to coexist in the same archive (defensive — shouldn't).
		if p := findInstallerExe(extractedDir); p != "" {
			target = p
		} else if p := findPortableExe(extractedDir); p != "" {
			return swapPortable(p)
		} else {
			return fmt.Errorf("추출 결과에서 인스톨러/.exe를 찾지 못했습니다 (%s)", extractedDir)
		}
	}

	if isInstaller(target) {
		return spawnInstaller(target)
	}
	return swapPortable(target)
}

func isInstaller(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	return strings.Contains(name, "installer") || strings.HasSuffix(name, ".msi")
}

func findInstallerExe(root string) string {
	var hit string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if isInstaller(p) && strings.HasSuffix(strings.ToLower(p), ".exe") {
			hit = p
		}
		return nil
	})
	return hit
}

func findPortableExe(root string) string {
	var hit string
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		lower := strings.ToLower(p)
		if strings.HasSuffix(lower, ".exe") && !isInstaller(p) {
			hit = p
		}
		return nil
	})
	return hit
}

func spawnInstaller(installerPath string) error {
	cmd := exec.Command(installerPath, "/S")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008, // DETACHED_PROCESS — outlive caller exit
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("인스톨러 실행 실패: %w", err)
	}
	return cmd.Process.Release()
}

// swapPortable spawns a detached PowerShell script that waits for the parent
// PID to exit, then overwrites the running exe with the freshly downloaded
// portable and relaunches it.
func swapPortable(newExe string) error {
	current, err := os.Executable()
	if err != nil {
		return fmt.Errorf("현재 실행 경로 확인 실패: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(current)
	if err == nil {
		current = resolved
	}
	helper, err := writePortableHelper(current, newExe, os.Getpid())
	if err != nil {
		return err
	}

	// PowerShell -WindowStyle Hidden so the helper doesn't flash a console.
	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy", "Bypass",
		"-WindowStyle", "Hidden",
		"-File", helper,
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x08000000, // DETACHED_PROCESS | CREATE_NO_WINDOW
		HideWindow:    true,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("교체 helper 실행 실패: %w", err)
	}
	return cmd.Process.Release()
}

func writePortableHelper(current, source string, parentPID int) (string, error) {
	dir, err := os.MkdirTemp("", "flipmd-swap-*")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "swap.ps1")
	script := fmt.Sprintf(`$ErrorActionPreference = "Stop"
$parent = %d
$source = %q
$target = %q

# Wait up to ~30s for the running app to exit so we can overwrite its file.
for ($i = 0; $i -lt 60; $i++) {
    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
}

$backup = "$target.bak"
try {
    if (Test-Path $target) { Move-Item -Force $target $backup }
    Move-Item -Force $source $target
    if (Test-Path $backup) { Remove-Item -Force $backup }
    Start-Process -FilePath $target
} catch {
    # rollback on failure
    if (Test-Path $backup) {
        if (Test-Path $target) { Remove-Item -Force $target }
        Move-Item -Force $backup $target
    }
    throw
}
`, parentPID, source, current)
	if err := os.WriteFile(path, []byte(script), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
