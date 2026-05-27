//go:build windows

package nodepath

import (
	"os"
	"path/filepath"
)

func osNodeCandidates(_ string) []string {
	var out []string
	for _, base := range programFiles() {
		out = append(out,
			filepath.Join(base, "nodejs", "node.exe"),
		)
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		out = append(out, filepath.Join(appData, "npm", "node.exe"))
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		out = append(out,
			filepath.Join(localAppData, "Programs", "nodejs", "node.exe"),
			filepath.Join(localAppData, "fnm_multishells", "node.exe"),
		)
	}
	return out
}

func osClaudeCandidates() []string {
	var out []string
	// 최우선: 사용자별 native 설치 위치
	//   C:\Users\<user>\.local\bin\claude.exe
	if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
		out = append(out, filepath.Join(userProfile, ".local", "bin", "claude.exe"))
	}
	// npm 글로벌 (npm install -g)
	if appData := os.Getenv("APPDATA"); appData != "" {
		out = append(out,
			filepath.Join(appData, "npm", "claude.cmd"),
			filepath.Join(appData, "npm", "claude.ps1"),
		)
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		out = append(out,
			filepath.Join(localAppData, "Programs", "nodejs", "claude.cmd"),
		)
	}
	for _, base := range programFiles() {
		out = append(out,
			filepath.Join(base, "nodejs", "claude.cmd"),
		)
	}
	return out
}

func osNpmGlobalRootCandidates(_ string) []string {
	var out []string
	if appData := os.Getenv("APPDATA"); appData != "" {
		out = append(out, filepath.Join(appData, "npm", "node_modules"))
	}
	for _, base := range programFiles() {
		out = append(out, filepath.Join(base, "nodejs", "node_modules"))
	}
	return out
}

func programFiles() []string {
	var out []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		if v := os.Getenv(env); v != "" {
			out = append(out, v)
		}
	}
	return out
}
