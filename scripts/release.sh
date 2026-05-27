#!/usr/bin/env bash
# FlipMD release pipeline — builds macOS + Windows artifacts, signs them with
# minisign in the Tauri-updater format, and produces a `latest.json` manifest
# that Go updater (internal/updater) can verify and apply.
#
# Required env / args:
#   VERSION                 e.g. 1.3.11                (required)
#   MINISIGN_SECRET_KEY     path to minisign private  (required for sign)
#   MINISIGN_PASSWORD       password for that key     (optional, prompts if missing)
#   APPLE_SIGNING_IDENTITY  Developer ID Application: ... (required on macOS)
#   GH_RELEASE              if "1" → gh release upload + create
#
# Skip switches: pass --skip-mac or --skip-windows to limit targets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
BIN="$ROOT/build/bin"
PATH_WITH_GO="$HOME/go/bin:$PATH"

# ── helpers ────────────────────────────────────────────────────────────────
log() { printf "\033[1;36m▸\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

# Tauri 시절 생성한 키는 base64로 한 번 더 wrap된 rsign 형식이라 표준
# minisign / rsign2 CLI에서 못 읽는다. Tauri CLI signer가 이 형식을
# 그대로 처리하므로 release flow는 tauri signer를 사용한다.
#
# 산출물은 `<file>.sig` (minisign 형식의 표준 .sig). 호출자가 base64로
# wrap해 latest.json에 넣을 때 우리 verify.go가 base64 한 단계를 풀고
# 처리하므로 호환된다. 기존 코드와의 호환을 위해 `.sig`를 `.minisig`로
# rename.
TAURI_CLI_DIR="${TAURI_CLI_DIR:-/Users/zerolive/work/flipbookMaker}"

sign_minisign() {
  local file="$1"
  local _trusted="$2"  # tauri signer는 trusted comment 인자 미지원 — 무시
  [[ -d "$TAURI_CLI_DIR/node_modules/@tauri-apps/cli" ]] || \
    die "tauri CLI signer를 못 찾음: $TAURI_CLI_DIR (TAURI_CLI_DIR로 경로 지정)"
  local out
  out=$(
    cd "$TAURI_CLI_DIR" && \
    npx tauri signer sign \
      -f "$MINISIGN_SECRET_KEY" \
      -p "${MINISIGN_PASSWORD:-}" \
      "$file" 2>&1
  ) || die "tauri signer 서명 실패: $file
$out"
  [[ -f "${file}.sig" ]] || die "${file}.sig 생성 실패"
  mv "${file}.sig" "${file}.minisig"
}

VERSION="${VERSION:-}"
SKIP_MAC=0
SKIP_WIN=0
GH_RELEASE="${GH_RELEASE:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-mac) SKIP_MAC=1; shift ;;
    --skip-windows) SKIP_WIN=1; shift ;;
    --upload) GH_RELEASE=1; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown arg: $1" ;;
  esac
done

[[ -n "$VERSION" ]] || die "VERSION not set (use --version 1.3.11 or env VERSION=...)"
[[ -n "${MINISIGN_SECRET_KEY:-}" ]] || die "MINISIGN_SECRET_KEY (path) is required for signing"
command -v minisign >/dev/null || die "minisign not installed (brew install minisign)"

if [[ -n "${MINISIGN_PUBLIC_KEY:-}" ]]; then
  PUBKEY_FILE="$MINISIGN_PUBLIC_KEY"
elif [[ -f "${MINISIGN_SECRET_KEY}.pub" ]]; then
  PUBKEY_FILE="${MINISIGN_SECRET_KEY}.pub"          # minisign 기본 (foo.key + foo.key.pub)
elif [[ -f "${MINISIGN_SECRET_KEY%.key}.pub" ]]; then
  PUBKEY_FILE="${MINISIGN_SECRET_KEY%.key}.pub"     # 일부 도구 (foo.key + foo.pub)
else
  die "minisign pubkey not found near $MINISIGN_SECRET_KEY — set MINISIGN_PUBLIC_KEY"
fi

rm -rf "$DIST"
mkdir -p "$DIST"

NOTES="${RELEASE_NOTES:-FlipMD ${VERSION}}"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# ── 1. macOS .app.tar.gz ───────────────────────────────────────────────────
SIG_MAC=""
URL_MAC=""
if [[ "$SKIP_MAC" -eq 0 ]]; then
  log "[macOS] wails build darwin/arm64"
  rm -rf "$BIN"
  PATH="$PATH_WITH_GO" wails build \
    -platform darwin/arm64 \
    -ldflags "-X main.appVersion=${VERSION}"

  # Wails는 appicon.png에서 .icns를 자동 생성하지만 단일 해상도라 Dock에서
  # 흐릿하다. flipbookMaker의 multi-resolution .icns가 있으면 덮어쓴다.
  if [[ -f "$ROOT/build/darwin/icon.icns" ]]; then
    log "[macOS] override iconfile.icns with build/darwin/icon.icns"
    cp "$ROOT/build/darwin/icon.icns" "$BIN/FlipMD.app/Contents/Resources/iconfile.icns"
  fi

  if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    log "[macOS] codesign $APPLE_SIGNING_IDENTITY"
    codesign --force --deep --options runtime \
      --sign "$APPLE_SIGNING_IDENTITY" "$BIN/FlipMD.app" >/dev/null
  else
    log "[macOS] APPLE_SIGNING_IDENTITY unset — skipping Developer ID re-sign (ad-hoc only)"
  fi

  # ── notarize + staple (옵션) ────────────────────────────────────────
  # APPLE_NOTARY_PROFILE이 있으면 Apple notarization 진행 + 티켓을 .app에
  # staple. 이후 tar.gz로 묶으면 stapled .app이 포함되어 사용자는
  # quarantine 우회 없이 바로 실행 가능.
  if [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
    log "[macOS] notarize via profile $APPLE_NOTARY_PROFILE (수 분 소요)"
    NOTARY_ZIP="$BIN/FlipMD-notarize-$$.zip"
    /usr/bin/ditto -c -k --keepParent "$BIN/FlipMD.app" "$NOTARY_ZIP"
    if ! xcrun notarytool submit "$NOTARY_ZIP" \
           --keychain-profile "$APPLE_NOTARY_PROFILE" --wait; then
      rm -f "$NOTARY_ZIP"
      die "notarization 실패. xcrun notarytool log <submission-id> --keychain-profile $APPLE_NOTARY_PROFILE 로 사유 확인"
    fi
    rm -f "$NOTARY_ZIP"
    log "[macOS] stapler staple"
    xcrun stapler staple "$BIN/FlipMD.app" >/dev/null || \
      die "stapler staple 실패"
    /usr/sbin/spctl -a -vv "$BIN/FlipMD.app" 2>&1 | head -3
  else
    log "[macOS] APPLE_NOTARY_PROFILE unset — skipping notarization (Gatekeeper 경고 발생 가능)"
  fi

  TAR_NAME="FlipMD_${VERSION}_aarch64.app.tar.gz"
  log "[macOS] tar -> $TAR_NAME"
  tar -C "$BIN" -czf "$DIST/$TAR_NAME" FlipMD.app

  log "[macOS] minisign sign"
  sign_minisign "$DIST/$TAR_NAME" "FlipMD ${VERSION} darwin-aarch64"

  SIG_MAC=$(base64 -i "$DIST/${TAR_NAME}.minisig" | tr -d '\n')
  URL_MAC="https://github.com/leonardo204/flipbookMaker-go/releases/download/v${VERSION}/${TAR_NAME}"
fi

# ── 2. Windows: NSIS installer (.nsis.zip) + portable (.zip) ───────────────
SIG_WIN=""
URL_WIN=""
SIG_WIN_PORT=""
URL_WIN_PORT=""
if [[ "$SKIP_WIN" -eq 0 ]]; then
  command -v makensis >/dev/null || die "NSIS (makensis) not installed (brew install makensis)"

  log "[Windows] wails build windows/amd64 -nsis"
  rm -rf "$BIN"
  PATH="$PATH_WITH_GO" wails build \
    -platform windows/amd64 \
    -nsis \
    -ldflags "-X main.appVersion=${VERSION}"

  INSTALLER=$(ls "$BIN"/*amd64-installer.exe 2>/dev/null | head -1) || true
  [[ -n "$INSTALLER" && -f "$INSTALLER" ]] || die "NSIS installer 산출물을 못 찾았습니다 ($BIN)"
  PORTABLE_EXE="$BIN/FlipMD.exe"
  [[ -f "$PORTABLE_EXE" ]] || die "portable FlipMD.exe 못 찾음 ($BIN)"

  # --- 2a. installer 자산
  ZIP_NAME="FlipMD_${VERSION}_x64-setup.nsis.zip"
  log "[Windows] zip(installer) -> $ZIP_NAME"
  ( cd "$BIN" && zip -j -q "$DIST/$ZIP_NAME" "$(basename "$INSTALLER")" )
  log "[Windows] minisign sign (installer)"
  sign_minisign "$DIST/$ZIP_NAME" "FlipMD ${VERSION} windows-x86_64"
  SIG_WIN=$(base64 -i "$DIST/${ZIP_NAME}.minisig" | tr -d '\n')
  URL_WIN="https://github.com/leonardo204/flipbookMaker-go/releases/download/v${VERSION}/${ZIP_NAME}"

  # --- 2b. portable 자산 (단독 .exe를 zip으로)
  ZIP_PORT="FlipMD_${VERSION}_x64-portable.zip"
  log "[Windows] zip(portable) -> $ZIP_PORT"
  ( cd "$BIN" && zip -j -q "$DIST/$ZIP_PORT" "FlipMD.exe" )
  log "[Windows] minisign sign (portable)"
  sign_minisign "$DIST/$ZIP_PORT" "FlipMD ${VERSION} windows-x86_64-portable"
  SIG_WIN_PORT=$(base64 -i "$DIST/${ZIP_PORT}.minisig" | tr -d '\n')
  URL_WIN_PORT="https://github.com/leonardo204/flipbookMaker-go/releases/download/v${VERSION}/${ZIP_PORT}"
fi

# ── 3. latest.json (Tauri updater 포맷) ────────────────────────────────────
LATEST="$DIST/latest.json"
log "[manifest] $LATEST"

{
  printf '{\n'
  printf '  "version": "%s",\n' "$VERSION"
  printf '  "notes": %s,\n' "$(printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
  printf '  "pub_date": "%s",\n' "$PUB_DATE"
  printf '  "platforms": {\n'

  first=1
  if [[ -n "$URL_MAC" ]]; then
    [[ $first -eq 1 ]] && first=0 || printf ',\n'
    printf '    "darwin-aarch64": {\n'
    printf '      "signature": "%s",\n' "$SIG_MAC"
    printf '      "url": "%s"\n' "$URL_MAC"
    printf '    }'
  fi
  if [[ -n "$URL_WIN" ]]; then
    [[ $first -eq 1 ]] && first=0 || printf ',\n'
    printf '    "windows-x86_64": {\n'
    printf '      "signature": "%s",\n' "$SIG_WIN"
    printf '      "url": "%s"\n' "$URL_WIN"
    printf '    }'
  fi
  if [[ -n "$URL_WIN_PORT" ]]; then
    [[ $first -eq 1 ]] && first=0 || printf ',\n'
    printf '    "windows-x86_64-portable": {\n'
    printf '      "signature": "%s",\n' "$SIG_WIN_PORT"
    printf '      "url": "%s"\n' "$URL_WIN_PORT"
    printf '    }'
  fi
  printf '\n  }\n'
  printf '}\n'
} > "$LATEST"

log "[manifest] preview:"
cat "$LATEST"

# ── 4. (옵션) gh release upload ────────────────────────────────────────────
if [[ "$GH_RELEASE" -eq 1 ]]; then
  command -v gh >/dev/null || die "gh CLI not installed"
  TAG="v${VERSION}"
  log "[gh] create release $TAG"
  if ! gh release view "$TAG" >/dev/null 2>&1; then
    gh release create "$TAG" --title "$TAG" --notes "$NOTES" || die "gh release create failed"
  fi
  log "[gh] upload assets"
  gh release upload "$TAG" "$DIST"/*.tar.gz "$DIST"/*.zip "$DIST"/*.minisig "$LATEST" --clobber
fi

log "Done. Artifacts in $DIST"
ls -la "$DIST"
