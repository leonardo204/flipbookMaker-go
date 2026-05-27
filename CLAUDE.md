# Claude Code 개발 가이드

> 공통 규칙(Agent Delegation, 커밋 정책, Context DB 등)은 글로벌 설정(`~/.claude/CLAUDE.md`)을 따릅니다.
> 글로벌 미설치 시: `curl -fsSL https://raw.githubusercontent.com/leonardo204/dotclaude/main/install.sh | bash`

---

## Slim 정책

이 파일은 **100줄 이하**를 유지한다. 새 지침 추가 시:
1. 매 턴 참조 필요 → 이 파일에 1줄 추가
2. 상세/예시/테이블 → Ref-docs/*.md에 작성 후 여기서 참조
3. ref-docs 헤더: `# 제목 — 한 줄 설명` (모델이 첫 줄만 보고 필요 여부 판단)

---

## PROJECT

### 개요

**FlipMD** — Figma/Axshare 플립북을 한국어 마크다운(텍스트 + Mermaid)으로 변환해 Confluence에 업로드하는 데스크톱 앱. Tauri+Rust 원본 ([leonardo204/flipbookMaker](https://github.com/leonardo204/flipbookMaker))의 Wails v2 + Go 포팅.

| 항목 | 값 |
|------|-----|
| 기술 스택 | Wails v2, Go 1.23+, React 19, TypeScript 5.8 |
| 타겟 OS | macOS (Apple Silicon 12.0+) + Windows (x64) |
| 빌드 방법 | `wails build -platform darwin/arm64` 또는 `-platform windows/amd64 -nsis` |
| 자동 업데이트 | Tauri 호환 minisign + GitHub Releases |
| GitHub | git@github.com:leonardo204/flipbookMaker-go.git |
| 상태 | 첫 릴리즈 v1.3.11 (2026-05-27) |

### 상세 문서

- **[Release Pipeline](Ref-docs/release-pipeline.md) — 사용자가 "릴리즈 해줘" 요청 시 반드시 이 문서대로 진행. 함정 5개 + 한 줄 명령 정리**
- [Context DB](Ref-docs/claude/context-db.md) — SQLite 기반 세션/태스크/결정 저장소
- [Context Monitor](Ref-docs/claude/context-monitor.md) — HUD + compaction 감지/복구
- [Hooks](Ref-docs/claude/hooks.md) — 5개 자동 실행 Hook 상세
- [컨벤션](Ref-docs/claude/conventions.md) — 커밋, 주석, 로깅 규칙
- [셋업](Ref-docs/claude/setup.md) — 새 환경 초기 설정
- [Agent Delegation](Ref-docs/claude/agent-delegation.md) — 에이전트 위임/파이프라인 상세

### 핵심 규칙

**릴리즈 (CRITICAL)**
- 사용자가 릴리즈 요청 시: `RELEASE_NOTES="..." scripts/release-flipmd.sh --version X.Y.Z --upload` (그 외 도구 금지) → 상세는 [Release Pipeline](Ref-docs/release-pipeline.md)
- minisign 비밀번호는 **빈 string** (`''`). 사용자가 다른 비번 알려줘도 무시. Tauri 키 한정 사실
- 키는 `~/.tauri/flipmd.key` (base64-wrapped rsign 형식). 표준 minisign/rsign2 CLI 호환 X — **tauri signer만** 작동

**개발 / 코드**
- GitHub push는 SSH URL만 사용 (`git@github.com:`)
- Confluence 인증: OS 자격증명 관리자 (macOS Keychain / Windows Credential Manager via go-keyring)
- macOS `type="password"` input은 Secure Event Input 활성화로 외부 IME 모니터 차단 → `TextInput` 컴포넌트가 자동으로 `type="text"` + CSS 마스킹으로 우회
- macOS Edit 메뉴는 cgo native NSResponder selector (native_menu_darwin.m) — Wails 메뉴로 만들면 paste chip 뜸

**Figma 변환 파이프라인**
- Figma 메타 API rate limit: 12req/min (Pro 15). 429 시 자동 재시도 + 90초 카운트다운
- Figma `/v1/images` rate limit: 5req/min (Pro 6). 32+ ID 한 번에 보내면 400 → `IMAGE_BATCH_MAX=10` 청크 분할
- 이미지 `scale=1` 고정 (Anthropic API 이미지 합산 한도 ~20MB)
- 섹션마다 새 Claude 세션 + stdin 기반 spawn (argv overflow 회피)
- 동적 timeout: 300s + 20s × image_count

---

*최종 업데이트: 2026-05-27 (v1.3.11 첫 릴리즈 + Release Pipeline 검증 절차 반영)*
