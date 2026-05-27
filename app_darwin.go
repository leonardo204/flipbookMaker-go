//go:build darwin

package main

import (
	"os/exec"

	"flipmd-go/internal/pathutil"
)

func openOSPath(path string) error {
	out, err := exec.Command("open", path).CombinedOutput()
	if err != nil {
		return wrapOpenErr(err, out)
	}
	return nil
}

func revealOSPath(path string) error {
	out, err := exec.Command("open", "-R", path).CombinedOutput()
	if err != nil {
		return wrapOpenErr(err, out)
	}
	return nil
}

func readPlaywrightVersion(pwDir string) string {
	s, _ := readPackageVersion(pwDir + "/package.json")
	return s
}

var _ = pathutil.HomeDir
