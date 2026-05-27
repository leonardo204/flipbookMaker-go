package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

func wrapOpenErr(err error, out []byte) error {
	if len(out) == 0 {
		return err
	}
	return fmt.Errorf("열기 실패: %v (%s)", err, strings.TrimSpace(string(out)))
}

func readPackageVersion(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "", err
	}
	return pkg.Version, nil
}
