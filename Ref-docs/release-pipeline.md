# Release Pipeline — Tauri-호환 자동 업데이트 빌드/배포 가이드

Go updater (`internal/updater`)는 Tauri updater 매니페스트 포맷을 그대로 사용합니다. `scripts/release.sh`가 macOS + Windows 빌드, minisign 서명, `latest.json` 생성을 한 번에 수행합니다.

---

## 사전 요구 사항 (macOS 빌드 머신)

| 도구 | 설치 | 비고 |
|------|------|------|
| Go 1.23+ | `brew install go` | wails build 의존 |
| Wails v2 CLI | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` | `$HOME/go/bin/wails` |
| Node.js 18+ | `brew install node` | frontend 빌드 |
| minisign | `brew install minisign` | 서명 |
| makensis | `brew install makensis` | Windows NSIS 인스톨러 |
| gh CLI (옵션) | `brew install gh` | `--upload` 자동화 |

Windows EV 코드사인 인증서가 있다면 `project.nsi`의 `!finalize` 라인을 켜고 `signtool` 경로를 잡아주세요.

---

## 환경 변수

```sh
export VERSION=1.3.11                                    # 필수
export MINISIGN_SECRET_KEY=~/.flipmd/minisign.key        # 필수 — 기존 flipbookMaker 키
export MINISIGN_PUBLIC_KEY=~/.flipmd/minisign.pub        # 옵션 (default: .key 이름 기반)
export MINISIGN_PASSWORD=...                             # 옵션 (생략 시 대화식 입력)
export APPLE_SIGNING_IDENTITY="Developer ID Application: YONGSUB LEE (XU8HS9JUTS)"
export GH_RELEASE=1                                      # gh release create + upload
export RELEASE_NOTES="버그 수정 및 안정성 개선"          # latest.json notes 필드
```

`MINISIGN_SECRET_KEY`는 **Tauri 시절 만들어 둔 키와 동일**해야 자동 업데이트가 작동합니다.
`main.go`의 `updaterPubKey` 상수와 키 짝이 맞지 않으면 클라이언트가 서명 검증을 거절합니다.

---

## 실행

```sh
# macOS + Windows 모두 빌드, latest.json 생성, gh release upload까지
scripts/release.sh --version 1.3.11 --upload

# macOS만
scripts/release.sh --version 1.3.11 --skip-windows

# Windows만
scripts/release.sh --version 1.3.11 --skip-mac
```

산출물은 `dist/` 폴더에 모입니다.

```
dist/
├── FlipMD_1.3.11_aarch64.app.tar.gz
├── FlipMD_1.3.11_aarch64.app.tar.gz.minisig
├── FlipMD_1.3.11_x64-setup.nsis.zip
├── FlipMD_1.3.11_x64-setup.nsis.zip.minisig
└── latest.json
```

---

## latest.json 형식

```json
{
  "version": "1.3.11",
  "notes": "버그 수정 및 안정성 개선",
  "pub_date": "2026-05-27T11:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<base64(.minisig 파일 내용)>",
      "url": "https://github.com/leonardo204/flipbookMaker/releases/download/v1.3.11/FlipMD_1.3.11_aarch64.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "<base64(.minisig 파일 내용)>",
      "url": "https://github.com/leonardo204/flipbookMaker/releases/download/v1.3.11/FlipMD_1.3.11_x64-setup.nsis.zip"
    }
  }
}
```

`internal/updater/manifest.go`가 이 JSON을 파싱하고, `verify.go`가 base64 wrapping을 풀어 minisign 검증합니다.

---

## 클라이언트 업데이트 흐름

1. **CheckUpdate** (`app.go`)
   - `updaterEndpoint`의 `latest.json` 다운로드
   - 현 버전과 비교, 새 버전이면 `pendingUpdate` 캐시
2. **DownloadAndInstallUpdate**
   - 플랫폼 자산 (`.app.tar.gz` 또는 `.nsis.zip`) 다운로드
   - minisign Ed25519 서명 검증
   - 임시 디렉터리에 압축 해제
   - `SwapAndRelaunch(dir)` 호출
     - **macOS**: detached shell helper가 `ditto`로 `.app` 교체 후 `open`으로 재시작
     - **Windows**: NSIS 인스톨러를 `/S` silent로 spawn — 인스톨러가 `${INSTDIR}\FlipMD.exe`를 자동 재실행

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------------|
| `pubkey 길이가 비정상` | `main.go`의 `updaterPubKey` 값이 minisign pubkey block과 불일치. 키쌍 확인. |
| `Ed25519 서명 검증 실패` | release 시 사용한 비밀키가 클라이언트의 pubkey와 다른 키쌍. |
| `.app 번들 안에서 실행 중이 아닙니다` | macOS 자동 업데이트는 `.app` 안에서 실행 시에만 동작. `wails dev`로 띄운 raw binary는 미지원. |
| NSIS 인스톨러가 자동 실행 안 됨 | `project.nsi`의 `${If} ${Silent} ... Exec` 블록 확인. silent (/S) 모드에서만 자동 launch. |
| macOS 자산 첫 실행 시 "확인되지 않은 개발자" | 코드사인 후 `xcrun notarytool submit`으로 노타라이즈 + staple 필요. release 파이프라인 외부 단계. |

---

## 노타라이즈 (선택)

자동 업데이트 자체는 노타라이즈 없이도 동작하지만, **첫 설치 시 사용자가 직접 우클릭 → 열기**로 Gatekeeper를 우회해야 합니다. 정식 배포에는 노타라이즈 권장.

```sh
# 사전: Apple ID app-specific password를 keychain에 등록
xcrun notarytool store-credentials FLIPMD_NOTARY \
  --apple-id you@example.com \
  --team-id XU8HS9JUTS \
  --password "xxxx-xxxx-xxxx-xxxx"

# release.sh 완료 후
xcrun notarytool submit dist/FlipMD_1.3.11_aarch64.app.tar.gz \
  --keychain-profile FLIPMD_NOTARY --wait

# .app에 staple (tar.gz 안의 .app은 풀어서 staple 후 다시 압축)
```

> 자동화는 별도 스크립트 (`scripts/notarize.sh`)로 분리 권장.
