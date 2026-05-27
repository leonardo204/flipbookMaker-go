// Package figma proxies authenticated requests to the Figma REST API and
// applies token-bucket-friendly retry semantics for 429 rate limits.
package figma

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Default tunables — kept loose because rate-limit windows on Figma's side
// recover within ~1 minute even when Retry-After hints at hours.
const (
	apiBase      = "https://api.figma.com"
	maxAttempts  = 3
	maxWaitSecs  = 30
	httpDuration = 60 * time.Second
)

// Proxy issues GET endpoint with the X-Figma-Token header and returns the raw body.
// Retries up to 3 times on HTTP 429.
func Proxy(ctx context.Context, endpoint, token string) (string, error) {
	if endpoint == "" {
		return "", errors.New("endpoint가 비어있습니다")
	}
	client := &http.Client{Timeout: httpDuration}
	url := apiBase + endpoint

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", fmt.Errorf("요청 생성 실패: %w", err)
		}
		req.Header.Set("X-Figma-Token", token)

		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("Figma API 요청 실패: %w", err)
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
			resp.Body.Close()
			if attempt == maxAttempts {
				return "", errors.New("Figma API 요청 한도 초과 (429). 1~2분 후 다시 시도하세요.")
			}
			waitFor := retryAfter
			if waitFor > maxWaitSecs {
				waitFor = maxWaitSecs
			}
			select {
			case <-time.After(time.Duration(waitFor) * time.Second):
			case <-ctx.Done():
				return "", ctx.Err()
			}
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			snippet := truncate(string(body), 200)
			return "", fmt.Errorf("Figma API 에러: %d (%s)", resp.StatusCode, snippet)
		}

		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return "", fmt.Errorf("응답 읽기 실패: %w", err)
		}
		return string(body), nil
	}

	return "", errors.New("Figma API 재시도 초과")
}

func parseRetryAfter(v string) int {
	if v == "" {
		return 30
	}
	if n, err := strconv.Atoi(v); err == nil && n > 0 {
		return n
	}
	return 30
}

func truncate(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n])
}
