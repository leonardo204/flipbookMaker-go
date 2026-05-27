// Package confluence interacts with the Confluence Cloud v1 REST API for
// page creation, image attachment, and parent-ID resolution.
package confluence

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

const httpTimeout = 90 * time.Second

// NormalizeBaseURL ensures the URL ends with `/wiki` so subsequent
// `/rest/api/...` joins do not produce `/wiki/wiki` duplicates.
func NormalizeBaseURL(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if strings.HasSuffix(trimmed, "/wiki") {
		return trimmed
	}
	return trimmed + "/wiki"
}

// Credentials holds the per-request auth tuple.
type Credentials struct {
	BaseURL string
	Email   string
	Token   string
}

// TestConnection probes /rest/api/user/current to verify credentials.
func TestConnection(ctx context.Context, c Credentials) error {
	base := NormalizeBaseURL(c.BaseURL)
	url := base + "/rest/api/user/current"
	log.Printf("[confluence.test] GET %s", url)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("요청 생성 실패: %w", err)
	}
	req.SetBasicAuth(c.Email, c.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := newClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(resp.Body)
	snippet := truncate(string(body), 200)
	return fmt.Errorf("HTTP %d: 인증 또는 URL 확인 필요. 응답: %s", resp.StatusCode, snippet)
}

// UploadRequest mirrors the Tauri payload.
type UploadRequest struct {
	BaseURL      string   `json:"baseUrl"`
	Email        string   `json:"email"`
	Token        string   `json:"token"`
	SpaceKey     string   `json:"spaceKey"`
	ParentPageID string   `json:"parentPageId,omitempty"`
	Title        string   `json:"title"`
	Content      string   `json:"content"`
	ImagePaths   []string `json:"imagePaths"`
}

// UploadResult mirrors the Tauri response shape.
type UploadResult struct {
	Success bool   `json:"success"`
	PageID  string `json:"pageId,omitempty"`
	PageURL string `json:"pageUrl,omitempty"`
	Message string `json:"message"`
}

// UploadPage creates a Confluence page and attaches images sequentially.
// Failures during attachment surface in Message but do not abort the call.
func UploadPage(ctx context.Context, req UploadRequest) (UploadResult, error) {
	base := NormalizeBaseURL(req.BaseURL)
	creds := Credentials{BaseURL: req.BaseURL, Email: req.Email, Token: req.Token}
	client := newClient()

	pageID, err := createPage(ctx, client, base, creds, req)
	if err != nil {
		return UploadResult{Success: false, Message: err.Error()}, nil
	}
	pageURL := fmt.Sprintf("%s/spaces/%s/pages/%s", base, req.SpaceKey, pageID)
	log.Printf("[confluence.upload] page created id=%s url=%s", pageID, pageURL)

	moveNote := reparentIfNeeded(ctx, client, base, creds, req, pageID)
	success, failures := attachImages(ctx, client, base, creds, pageID, req.ImagePaths)
	summary := buildSummary(success, failures, moveNote)
	log.Printf("[confluence.upload] %s", summary)

	return UploadResult{
		Success: true,
		PageID:  pageID,
		PageURL: pageURL,
		Message: summary,
	}, nil
}

// ResolveParentPageID accepts an ID, a URL, or a title-ish string and tries
// to extract the parent ID. Pure-digit input is treated as an ID directly.
func ResolveParentPageID(input string) string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return ""
	}
	if isAllDigits(trimmed) {
		return trimmed
	}
	if idx := strings.Index(trimmed, "/pages/"); idx >= 0 {
		tail := trimmed[idx+len("/pages/"):]
		var id strings.Builder
		for _, r := range tail {
			if !unicode.IsDigit(r) {
				break
			}
			id.WriteRune(r)
		}
		if id.Len() > 0 {
			return id.String()
		}
	}
	return ""
}

func createPage(ctx context.Context, client *http.Client, base string, c Credentials, r UploadRequest) (string, error) {
	url := base + "/rest/api/content"
	log.Printf("[confluence.upload] POST %s space=%s title=%s parent=%q images=%d",
		url, r.SpaceKey, r.Title, r.ParentPageID, len(r.ImagePaths))

	body := map[string]any{
		"type":  "page",
		"title": r.Title,
		"space": map[string]any{"key": r.SpaceKey},
		"body": map[string]any{
			"storage": map[string]any{
				"value":          r.Content,
				"representation": "storage",
			},
		},
	}
	if r.ParentPageID != "" {
		body["ancestors"] = []map[string]string{{"id": r.ParentPageID}}
	} else {
		body["ancestors"] = []any{}
	}

	payload, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("페이지 페이로드 직렬화 실패: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("페이지 생성 요청 실패: %w", err)
	}
	req.SetBasicAuth(c.Email, c.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("페이지 생성 요청 실패: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[confluence.upload] FAILED status=%d body=%s", resp.StatusCode, truncate(string(respBody), 400))
		return "", fmt.Errorf("페이지 생성 실패 HTTP %d: %s", resp.StatusCode, truncate(string(respBody), 400))
	}

	var page struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &page); err != nil {
		return "", fmt.Errorf("페이지 생성 응답 파싱 실패: %w", err)
	}
	return page.ID, nil
}

func reparentIfNeeded(ctx context.Context, client *http.Client, base string, c Credentials, r UploadRequest, pageID string) string {
	if r.ParentPageID == "" {
		return ""
	}
	checkURL := fmt.Sprintf("%s/rest/api/content/%s?expand=ancestors,version,space", base, pageID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, checkURL, nil)
	if err != nil {
		return ""
	}
	req.SetBasicAuth(c.Email, c.Token)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[confluence.upload] ancestors GET err=%v", err)
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("[confluence.upload] ancestors GET status=%d", resp.StatusCode)
		return ""
	}

	var info struct {
		Title     string `json:"title"`
		Space     struct{ Key string } `json:"space"`
		Version   struct{ Number int } `json:"version"`
		Ancestors []struct {
			ID string `json:"id"`
		} `json:"ancestors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return ""
	}
	actualParent := ""
	if len(info.Ancestors) > 0 {
		actualParent = info.Ancestors[len(info.Ancestors)-1].ID
	}
	if actualParent == r.ParentPageID {
		return ""
	}

	log.Printf("[confluence.upload] 부모 불일치 expected=%s actual=%s → 자동 이동 시도", r.ParentPageID, actualParent)
	title := info.Title
	if title == "" {
		title = r.Title
	}
	spaceKey := info.Space.Key
	if spaceKey == "" {
		spaceKey = r.SpaceKey
	}
	moveBody := map[string]any{
		"id":    pageID,
		"type":  "page",
		"title": title,
		"space": map[string]any{"key": spaceKey},
		"version": map[string]any{
			"number": info.Version.Number + 1,
		},
		"ancestors": []map[string]string{{"id": r.ParentPageID}},
		"body": map[string]any{
			"storage": map[string]any{
				"value":          r.Content,
				"representation": "storage",
			},
		},
	}
	payload, err := json.Marshal(moveBody)
	if err != nil {
		return ""
	}
	moveURL := fmt.Sprintf("%s/rest/api/content/%s", base, pageID)
	mReq, err := http.NewRequestWithContext(ctx, http.MethodPut, moveURL, bytes.NewReader(payload))
	if err != nil {
		return ""
	}
	mReq.SetBasicAuth(c.Email, c.Token)
	mReq.Header.Set("Content-Type", "application/json")
	mReq.Header.Set("Accept", "application/json")
	mResp, err := client.Do(mReq)
	if err != nil {
		return fmt.Sprintf(" (⚠️ 부모 %s 이지만 이동 실패: %v)", actualParent, err)
	}
	defer mResp.Body.Close()
	if mResp.StatusCode >= 200 && mResp.StatusCode < 300 {
		log.Printf("[confluence.upload] 자동 이동 성공 → 부모 %s", r.ParentPageID)
		return fmt.Sprintf(" (부모 %s로 자동 이동됨 — 원래 부모: %s)", r.ParentPageID, actualParent)
	}
	body, _ := io.ReadAll(mResp.Body)
	return fmt.Sprintf(" (⚠️ 부모가 %s 이지만 의도한 %s 으로 이동 실패: HTTP %d %s)",
		actualParent, r.ParentPageID, mResp.StatusCode, truncate(string(body), 150))
}

func attachImages(ctx context.Context, client *http.Client, base string, c Credentials, pageID string, paths []string) (int, []string) {
	successCount := 0
	var failures []string
	for _, p := range paths {
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			failures = append(failures, fmt.Sprintf("(파일 없음) %s", p))
			continue
		}
		name := filepath.Base(p)
		file, err := os.ReadFile(p)
		if err != nil {
			failures = append(failures, fmt.Sprintf("(읽기 실패: %v) %s", err, name))
			continue
		}

		body := &bytes.Buffer{}
		mw := multipart.NewWriter(body)
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, name))
		header.Set("Content-Type", "image/png")
		part, err := mw.CreatePart(header)
		if err != nil {
			failures = append(failures, fmt.Sprintf("(multipart part 실패: %v) %s", err, name))
			continue
		}
		if _, err := part.Write(file); err != nil {
			failures = append(failures, fmt.Sprintf("(multipart write 실패: %v) %s", err, name))
			continue
		}
		if err := mw.Close(); err != nil {
			failures = append(failures, fmt.Sprintf("(multipart close 실패: %v) %s", err, name))
			continue
		}

		attachURL := fmt.Sprintf("%s/rest/api/content/%s/child/attachment", base, pageID)
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, attachURL, body)
		if err != nil {
			failures = append(failures, fmt.Sprintf("(요청 생성 실패: %v) %s", err, name))
			continue
		}
		req.SetBasicAuth(c.Email, c.Token)
		req.Header.Set("X-Atlassian-Token", "nocheck")
		req.Header.Set("Content-Type", mw.FormDataContentType())

		resp, err := client.Do(req)
		if err != nil {
			failures = append(failures, fmt.Sprintf("(요청 실패: %v) %s", err, name))
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			successCount++
		} else {
			respBody, _ := io.ReadAll(resp.Body)
			failures = append(failures, fmt.Sprintf("(HTTP %d: %s) %s", resp.StatusCode, truncate(string(respBody), 150), name))
		}
		resp.Body.Close()

		// Confluence 첨부 rate-limit 방어
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return successCount, append(failures, "(중단됨)")
		}
	}
	return successCount, failures
}

func buildSummary(success int, failures []string, moveNote string) string {
	if len(failures) == 0 {
		return fmt.Sprintf("페이지 생성 성공 — 이미지 %d개 첨부 완료%s", success, moveNote)
	}
	preview := strings.Join(takeStrings(failures, 3), "; ")
	extra := ""
	if len(failures) > 3 {
		extra = fmt.Sprintf(" 외 %d건", len(failures)-3)
	}
	return fmt.Sprintf("페이지 생성 성공 — 이미지 %d개 첨부, %d건 실패%s: %s%s",
		success, len(failures), extra, preview, moveNote)
}

func takeStrings(in []string, n int) []string {
	if len(in) <= n {
		return in
	}
	return in[:n]
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return s != ""
}

func truncate(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n])
}

func newClient() *http.Client {
	return &http.Client{Timeout: httpTimeout}
}
