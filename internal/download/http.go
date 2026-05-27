// Package download handles HTTP file downloads (e.g. Figma S3 PNGs).
package download

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"flipmd-go/internal/pathutil"
)

// ToFile streams a URL into destPath. Parent directories are created.
// Returns bytes written.
func ToFile(ctx context.Context, url, destPath string) (int64, error) {
	dest := pathutil.ExpandTilde(destPath)
	if parent := filepath.Dir(dest); parent != "" {
		if err := os.MkdirAll(parent, 0o755); err != nil {
			return 0, fmt.Errorf("디렉토리 생성 실패: %w (%s)", err, parent)
		}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, fmt.Errorf("요청 생성 실패: %w", err)
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("다운로드 요청 실패: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return 0, fmt.Errorf("HTTP %d 다운로드 실패", resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return 0, fmt.Errorf("파일 생성 실패: %w (%s)", err, dest)
	}
	defer f.Close()

	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return n, fmt.Errorf("파일 쓰기 실패: %w (%s)", err, dest)
	}
	return n, nil
}
