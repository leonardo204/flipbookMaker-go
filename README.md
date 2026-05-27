# FlipMD

> Figma/Axshare UI 플립북을 한국어 마크다운(텍스트 + Mermaid)으로 변환해 Confluence에 업로드하는 **macOS + Windows** 데스크톱 앱.
> [flipbookMaker](https://github.com/leonardo204/flipbookMaker) (Tauri+Rust)의 Wails v2 + Go 포팅 버전.

[![Wails](https://img.shields.io/badge/Wails-v2-DF0000)](https://wails.io/)
[![Go](https://img.shields.io/badge/Go-1.23+-00ADD8)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#)

---

## 무엇을 하나요

Figma 플립북(UI 시나리오 문서)을 분석해 **각 섹션별로 한국어 마크다운 문서**를 생성합니다. 생성된 문서는 그대로 Confluence에 업로드 가능합니다.

- Figma 프레임을 PNG로 렌더링 → Claude vision이 이미지 + 메타데이터 함께 분석
- 같은 카테고리의 여러 프레임은 **의미 그룹 단위**의 한국어 문서로 통합
- Mermaid 다이어그램은 Confluence 호환 규칙으로 출력
- Confluence REST API로 페이지 직접 생성 + 이미지 첨부
- **Tauri 호환 자동 업데이트** — 본 저장소(flipbookMaker-go) GitHub Releases + 기존 flipbookMaker minisign 키 재사용

## 핵심 특징

| 특징 | 설명 |
|------|------|
| Vision 기반 변환 | Figma `/v1/images` PNG + 노드 메타를 Claude에 함께 전달 |
| Rate limit 안전 | 토큰 버킷 — 메타 12/min, 이미지 5/min. 청크 분할(10ids) + 자동 재시도 |
| Hallucination 차단 | 입력에 없는 내용 추론 금지, 출처 인용 강제, 빈약 입력은 정직하게 짧게 |
| 한국어 출력 | 소제목/표 헤더 번역, 원문 인용은 보존 + `*(번역)*` 부기 |
| 개별/일괄 변환 | 섹션 단위 체크박스 + 행별 [변환]/[재시도]/[재변환] |
| 자동 업데이트 | macOS .app ditto 스왑, Windows NSIS/portable 양쪽 지원 |
| 한영 표시 호환 | 패스워드 입력란도 `type=text` + CSS 마스킹으로 IME 모니터링 차단 회피 |

## 사전 요구사항

| 도구 | 버전 | 용도 |
|------|------|------|
| Go | 1.23+ | 빌드 |
| Node.js | 18+ | 프론트엔드 빌드 |
| [Wails CLI](https://wails.io/docs/gettingstarted/installation) | v2.12+ | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |
| [Claude Code CLI](https://docs.claude.com/claude-code) | 최신 | 변환 엔진 — 미설치 시 변환 버튼 비활성 |
| Figma Personal Access Token | — | 설정 화면에서 입력 |
| Confluence API Token | — | 업로드용 (선택) |

릴리즈 빌드용 추가:

| 도구 | 용도 |
|------|------|
| `minisign` | `.app.tar.gz` / `.zip` 서명 |
| `makensis` | Windows NSIS 인스톨러 (macOS에서 `brew install makensis`) |
| `gh` (선택) | `release.sh --upload`로 GitHub Releases 자동 업로드 |

## 설치 / 빌드

```bash
git clone git@github.com:leonardo204/flipbookMaker-go.git
cd flipbookMaker-go

# 개발 모드 (live reload)
wails dev

# macOS .app 빌드
wails build -platform darwin/arm64

# Windows .exe + NSIS 인스톨러
wails build -platform windows/amd64 -nsis

# 통합 릴리즈 (서명 + latest.json + gh upload)
scripts/release.sh --version 1.3.11 --upload
```

자세한 릴리즈 파이프라인은 [Ref-docs/release-pipeline.md](Ref-docs/release-pipeline.md) 참조.

## 사용 흐름

1. **설정 화면** (`Cmd+,` / `Ctrl+,`): Claude Code 경로, Figma PAT, Confluence 정보 입력
2. **홈 화면**: Figma 디자인 URL 붙여넣기 → 출력 폴더 지정
3. **분석 화면**: 섹션 목록에서 변환할 항목 체크 (자동 시각 순서 정렬)
4. **변환 화면**:
   - 일괄 변환 자동 시작 (선택된 섹션만)
   - 행별 [변환]/[재시도]/[재변환] 가능
   - 실패 시 에러 메시지 클릭 → 상세 사유 펼치기
5. **업로드 화면**: 부모 페이지 ID/URL 지정 → Confluence에 일괄 업로드

## 프로젝트 구조

```
flipbookMaker-go/
├── main.go                       # Wails 옵션 + 메뉴
├── app.go (+ _darwin/_windows/_linux/_helpers)
│                                 # 14개 Tauri command → PascalCase Go 메서드
├── native_menu_darwin.{go,h,m}   # cgo로 native NSResponder Edit 메뉴 (Cmd+V)
├── menu_clipboard.go             # Wails 메뉴 → JS 이벤트 브릿지 (cut/copy)
├── internal/
│   ├── pathutil/                 # ExpandTilde, HomeDir
│   ├── nodepath/                 # node/claude/playwright 경로 탐색 (OS별)
│   ├── credstore/                # OS 자격증명 관리자 래퍼
│   ├── download/                 # HTTP 파일 다운로드
│   ├── fsutil/                   # plugin-fs 대용
│   ├── figma/                    # API 프록시 + 429 재시도
│   ├── confluence/               # 페이지 생성 + 이미지 첨부 + 부모 재배치
│   ├── claudecli/                # stdin 기반 Claude --print
│   ├── runner/                   # node 스크립트 + stdout 이벤트
│   ├── updater/                  # Tauri 호환 minisign + .app/.exe 교체
│   ├── selfupdate/               # (deprecated stub)
│   └── scripts/assets/crawl.mjs  # embed.FS → 런타임 temp dir로 추출
├── frontend/
│   ├── src/                      # React 19 + TypeScript 5.8
│   │   ├── pages/                # Input / Analyze / Convert / Upload / Settings
│   │   ├── components/           # TextInput (CSS 마스킹), Modals, ...
│   │   ├── contexts/             # WorkflowContext, SettingsContext
│   │   ├── services/             # claudeService, figmaService, claudeSession
│   │   └── shims/tauri/          # @tauri-apps/* 9개 모듈 → Wails 브릿지
│   └── wailsjs/                  # Wails 자동 생성 (gitignore)
├── build/
│   ├── appicon.png               # 1024px 원본 (Wails 자동 변환용)
│   ├── darwin/
│   │   ├── Info.plist            # BundleID, minOS 12.0
│   │   └── icon.icns             # multi-resolution macOS 아이콘
│   └── windows/
│       ├── icon.ico              # Windows 아이콘
│       └── installer/project.nsi # NSIS — silent 자동 launch + Finish 페이지 실행 체크박스
├── scripts/release.sh            # 통합 릴리즈 파이프라인
└── Ref-docs/
    └── release-pipeline.md       # release.sh 사용법, minisign, NSIS, 노타라이즈
```

## 기술 스택

- **프론트엔드**: React 19, TypeScript 5.8, Vite 6, React Router 7
- **데스크톱 프레임워크**: [Wails v2](https://wails.io/) (WKWebView / Edge WebView2)
- **백엔드 (Go)**:
  - `claudecli` — stdin 기반 Claude CLI 호출 (argv overflow 회피)
  - `figma` — REST API 프록시 + 429 재시도
  - `confluence` — 페이지 생성 + 이미지 첨부 + 부모 자동 이동
  - `credstore` — [zalando/go-keyring](https://github.com/zalando/go-keyring) (macOS Keychain / Windows Credential Manager)
  - `updater` — Tauri 호환 minisign Ed25519 검증 + 플랫폼별 적용
- **변환 엔진**: Claude Code CLI (vision)

## 변환 파이프라인 (Figma)

```
1. /v1/files/.../nodes (메타 트리)        ← rate limit 12/min
2. collectFrameIds (시각 순서 정렬)
3. /v1/images (PNG batch, 10ids 청크)    ← rate limit 5/min
4. download_to_file × N                   ← Figma rate limit 미적용
5. claude_print (stdin)                   ← prompt + image paths
   └ Claude가 Read 도구로 이미지 모두 읽기
   └ 의미 그룹 단위로 한국어 마크다운 생성
6. /{outputDir}/{section-slug}.md 저장
```

## 자동 업데이트

[Ref-docs/release-pipeline.md](Ref-docs/release-pipeline.md) 참조. 핵심 흐름:

- **CheckUpdate**: `https://github.com/leonardo204/flipbookMaker-go/releases/latest/download/latest.json` 다운로드 → 버전 비교
- **DownloadAndInstall**:
  - macOS: `.app.tar.gz` → minisign 검증 → 임시 디렉터리 추출 → detached shell helper로 `ditto` 스왑 → `open`으로 재시작
  - Windows installer: `.nsis.zip` → 추출 → silent (`/S`) NSIS → `$INSTDIR\FlipMD.exe` 자동 실행
  - Windows portable: `.zip` → 추출 → PowerShell hidden helper로 자기 .exe 교체 → 재시작

`internal/updater/manifest.go`가 실행 위치(`%ProgramFiles%` 여부)로 portable / installed를 자동 판정합니다.

## 알려진 제약

- Anthropic API 한 요청 이미지 합산 한도 ~20MB → `scale=1`로 고정
- 매우 큰 섹션(36+ 프레임)은 17분까지 timeout 확장
- Confluence는 페이지당 표/이미지 수가 많으면 렌더 지연. 큰 섹션은 분할 업로드 권장
- macOS Secure Event Input 우회를 위해 password 입력란은 `type=text` + CSS `-webkit-text-security` 사용
- 자동 업데이트는 macOS는 `.app` 안에서 실행 시에만 동작 (`wails dev`로 띄운 raw binary 미지원)

## 문서

- [CLAUDE.md](CLAUDE.md) — 프로젝트 규칙 / AI 협업 가이드
- [Ref-docs/release-pipeline.md](Ref-docs/release-pipeline.md) — 릴리즈 파이프라인
- [Ref-docs/claude/](Ref-docs/claude/) — dotclaude 시스템 문서 (Context DB, hooks, conventions)
- [flipbookMaker (원본)](https://github.com/leonardo204/flipbookMaker) — Tauri+Rust 버전

## 라이선스

MIT
