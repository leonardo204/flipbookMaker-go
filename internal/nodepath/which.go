package nodepath

import (
	"os/exec"
	"runtime"
	"strings"
)

// whichCommand asks the OS to resolve `name` against the current PATH and
// PATHEXT (Windows). Returns the first match or "" on failure. Used as a
// last-resort fallback when hand-coded candidates miss the install location.
//
// This is essential on Windows because:
//   - npm-installed CLIs land in %APPDATA%\npm (per-user) which is in the
//     user's PATH but only as `claude` (a sh script) and `claude.cmd`.
//   - Wails apps launched via Explorer may inherit only the system PATH,
//     missing the per-user entries.
//   - cmd.exe's `where` resolves both PATH and PATHEXT correctly.
//
// On macOS/Linux we use the standard `which`.
func whichCommand(name string) string {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("cmd", "/c", "where", name).Output()
		if err != nil {
			return ""
		}
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimRight(strings.TrimSpace(line), "\r")
			if line == "" {
				continue
			}
			// Prefer .cmd / .exe over the bash script (no extension) because
			// the bash variant requires sh.exe which the GUI app may not have.
			lower := strings.ToLower(line)
			if strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".exe") || strings.HasSuffix(lower, ".bat") {
				return line
			}
		}
		// Fallback: first non-empty line even if no preferred extension.
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimRight(strings.TrimSpace(line), "\r")
			if line != "" {
				return line
			}
		}
		return ""
	}

	out, err := exec.Command("which", name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
