# Release Pipeline — 검증된 릴리즈 절차 (Tauri-호환 자동 업데이트)

> 사용자가 "릴리즈 해줘" / "vX.Y.Z 발행" 등을 요청하면 **반드시 이 문서대로 진행**한다.
> 검증 완료 일자: 2026-05-27 (v1.3.11 발행)

---

## 한 줄 명령 (이게 전부)

```sh
cd /Users/zerolive/work/flipMd-Go && \
  RELEASE_NOTES="<릴리즈 노트>" \
  scripts/release-flipmd.sh --version <X.Y.Z> --upload
```

비대화식 — `.env`에서 모든 비밀을 자동 로드, Claude Code inline bash에서도 동작.
실행 1~2분, 완료 시 `https://github.com/leonardo204/flipbookMaker-go/releases/tag/v<X.Y.Z>`.

---

## 사전 1회 셋업 (이미 되어 있다면 스킵)

| 항목 | 상태 확인 | 설치 / 등록 |
|------|----------|-------------|
| Go 1.23+ | `go version` | `brew install go` |
| Node 18+ | `node -v` | `brew install node` |
| Wails CLI v2.12+ | `wails version` | `go install github.com/wailsapp/wails/v2/cmd/wails@latest` |
| `makensis` (Windows 빌드용) | `which makensis` | `brew install makensis` |
| `gh` CLI 인증 | `gh auth status` | `gh auth login` |
| **Tauri CLI (`tauri signer`)** | `ls /Users/zerolive/work/flipbookMaker/node_modules/@tauri-apps/cli` | flipbookMaker repo에 `npm install` |
| **Tauri 시절 minisign 키** | `ls ~/.tauri/flipmd.key*` | (보관 중) |
| **`.env` 파일** | `cat .env` | 아래 내용으로 작성 |

`.env` 내용 (gitignore됨):
```bash
MINISIGN_PASSWORD=''
APPLE_ID='<Developer Program 등록된 Apple ID>'
APPLE_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx'  # appleid.apple.com → 앱 암호
APPLE_TEAM_ID='XU8HS9JUTS'
```

app-specific password 발급: https://appleid.apple.com → 로그인 및 보안 → 앱 암호. release-flipmd.sh가 첫 실행 시 keychain profile(FLIPMD_NOTARY)을 자동 등록한다.

---

## 절대 함정 — 처음 시도하면 무조건 막힘

### 함정 1 — Tauri 키 형식

`~/.tauri/flipmd.key`는 base64로 한 번 더 wrap된 **rsign 형식**이라 표준 `minisign` / `rsign2` CLI에서 `"Missing encoded key in secret key"` 또는 `"Wrong password for that key"` 오류 발생.

**해결**: `scripts/release.sh`가 `tauri signer` (flipbookMaker의 `node_modules/@tauri-apps/cli`) 호출. 이미 작성 완료 — 다른 도구 시도 금지.

### 함정 2 — 비밀번호는 **빈 string**

사용자가 다른 비번을 알려줘도 무시. Tauri 키는 빈 비밀번호로 보호됨. `.env`의 `MINISIGN_PASSWORD=''`가 정답.

검증 방법:
```sh
cd /Users/zerolive/work/flipbookMaker && \
  npx tauri signer sign -f ~/.tauri/flipmd.key -p '' /tmp/dummy.txt
# "Your file was signed successfully" 나오면 OK
```

### 함정 3 — env var "" 와 CLI 인자 "" 가 다름

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` env var는 "unset"으로 처리되어 다른 fallback로 빠짐 → wrong password. **반드시 CLI 인자 `-p "$MINISIGN_PASSWORD"` 형식으로** 전달. release.sh가 이미 그렇게 함.

### 함정 4 — `${VAR:-}` vs `${VAR+set}`

빈 비밀번호가 valid이므로 `[[ -z "${MINISIGN_PASSWORD:-}" ]]` 검사는 거짓 트리거. `${VAR+set}` 으로 unset 여부만 검사. release-flipmd.sh 이미 그렇게 함.

### 함정 5 — Claude Code inline bash는 인터랙티브 입력 불가

`!` prefix로 실행되는 bash는 stdin 없음. `read -sp`는 EOF로 즉시 종료. → `.env` 자동 로드가 유일한 자동화 길. (외부 터미널은 인터랙티브 가능)

---

## 진행 흐름 (release.sh 내부)

```
1. wails build darwin/arm64 + ldflags appVersion=X.Y.Z
2. iconfile.icns override (build/darwin/icon.icns → .app/Contents/Resources)
3. codesign (Developer ID Application: YONGSUB LEE)
4. notarize: ditto → notarytool submit --wait (Accepted까지 2~5분) → stapler staple
5. tar -czf FlipMD_X.Y.Z_aarch64.app.tar.gz   (← stapled .app 포함)
6. tauri signer sign → .sig → .minisig
7. wails build windows/amd64 -nsis
8. zip (installer .exe → FlipMD_X.Y.Z_x64-setup.nsis.zip)
9. tauri signer + .minisig
10. zip (portable .exe → FlipMD_X.Y.Z_x64-portable.zip)
11. tauri signer + .minisig
12. latest.json 생성 (3 platforms: darwin-aarch64, windows-x86_64, windows-x86_64-portable)
13. gh release create + 7개 자산 upload
```

`APPLE_NOTARY_PROFILE` env가 비어 있으면 4단계 스킵 (Gatekeeper 경고 발생).

---

## latest.json 구조

```json
{
  "version": "1.3.11",
  "notes": "...",
  "pub_date": "2026-05-27T09:30:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<base64 wrap of .minisig 내용>",
      "url": "https://github.com/leonardo204/flipbookMaker-go/releases/download/v1.3.11/FlipMD_1.3.11_aarch64.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "...",
      "url": ".../FlipMD_1.3.11_x64-setup.nsis.zip"
    },
    "windows-x86_64-portable": {
      "signature": "...",
      "url": ".../FlipMD_1.3.11_x64-portable.zip"
    }
  }
}
```

`internal/updater/verify.go`가 base64 wrap을 풀고 minisign Ed25519 검증.

---

## 클라이언트 자동 업데이트 흐름

| 단계 | macOS | Windows installer | Windows portable |
|------|-------|-------------------|------------------|
| 1. CheckUpdate | `latest.json` 다운로드 → 버전 비교 | 동일 | 동일 |
| 2. 자산 fetch | `.app.tar.gz` | `.nsis.zip` | `.zip` |
| 3. 검증 | minisign Ed25519 (`updaterPubKey` 상수) | 동일 | 동일 |
| 4. 추출 | temp dir에 풀기 | 동일 | 동일 |
| 5. 적용 | shell helper로 `ditto` 스왑 → `open` 재시작 | NSIS `/S` silent → 자동 launch | PowerShell helper로 .exe 교체 → 재시작 |

플랫폼 자동 판정: `internal/updater/manifest.go`의 `IsPortable()` (실행 위치가 `%ProgramFiles%` 하위인지).

---

## 실 검증 시나리오

1. 이전 버전 빌드 보관:
   ```sh
   wails build -platform darwin/arm64 -ldflags "-X main.appVersion=1.3.10"
   codesign --force --deep --options runtime --sign "Developer ID Application: YONGSUB LEE (XU8HS9JUTS)" build/bin/FlipMD.app
   cp -r build/bin/FlipMD.app /tmp/FlipMD-1.3.10.app
   ```
2. 새 버전 발행 (위 한 줄 명령으로 1.3.11)
3. 이전 버전 실행:
   ```sh
   open /tmp/FlipMD-1.3.10.app
   ```
4. 설정 페이지 → "업데이트 확인" → 1.3.11 발견 → 다운로드/검증/적용 → 자동 재시작 후 1.3.11

---

## 트러블슈팅

| 증상 | 원인 / 해결 |
|------|------------|
| `MINISIGN_PASSWORD 없음` | `.env` 누락. `.env.example` 참고해 생성 |
| `tauri CLI signer를 못 찾음: ...` | flipbookMaker repo에서 `npm install` 필요. 또는 `TAURI_CLI_DIR` 환경변수로 다른 경로 지정 |
| `Wrong password for that key` | 비밀번호 잘못. **빈 string `''` 가 정답** (Tauri 키 한정) |
| `Missing encoded key in secret key` | `~/.tauri/flipmd.key`를 minisign / rsign2 CLI로 시도. **tauri signer를 써야 함** |
| `gh release create failed` | `gh auth status` 확인, repo write 권한 |
| Ed25519 서명 검증 실패 (클라이언트) | release 시 키쌍과 `main.go`의 `updaterPubKey` 상수가 다른 키. 기존 키 그대로 사용 |
| `.app 번들 안에서 실행 중이 아닙니다` | macOS 자동 업데이트는 `.app` 안에서 실행 시에만 동작. `wails dev` raw binary 미지원 |
| NSIS 인스톨러 자동 실행 안 됨 | `project.nsi`의 `${If} ${Silent} ... Exec` 블록 확인. silent (`/S`) 모드에서만 자동 launch |

---

## 노타라이즈 — 이미 자동화됨 (v1.3.12부터)

release.sh 4단계가 자동으로 처리:
1. `.app` → 임시 `.zip` (ditto, keepParent)
2. `xcrun notarytool submit --wait` (Apple 서버 검증, Accepted까지 보통 2~5분)
3. `xcrun stapler staple FlipMD.app` (티켓을 .app에 직접 박음)
4. `spctl -a -vv` 결과 확인 (`source=Notarized Developer ID` 출력되어야 정상)

이후 tar.gz로 묶기 때문에 사용자는 **다운로드 → 더블클릭으로 즉시 실행** 가능 (Gatekeeper 우회 불필요).

자격증명은 `.env`에 적힌 APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID를 release-flipmd.sh가 첫 실행 시 keychain(FLIPMD_NOTARY)에 자동 등록. 다음 release부터는 keychain만 사용 — `.env`의 Apple 항목은 백업용.

직접 등록도 가능:
```sh
xcrun notarytool store-credentials FLIPMD_NOTARY \
  --apple-id "<Developer ID 등록된 Apple ID>" \
  --team-id "XU8HS9JUTS" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

**HTTP 401 / Invalid credentials**: Apple ID가 그 Team의 Developer Program 멤버가 아니거나 app-specific password 오타. 멤버 권한 + 새 password 재발급으로 해결.
