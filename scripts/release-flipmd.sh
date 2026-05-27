#!/usr/bin/env bash
# FlipMD release 편의 래퍼 — minisign 비밀번호를 macOS Keychain에서 가져와
# 비대화식으로 자동 진행. 한 번만 미리 등록해 두면 Claude Code inline bash나
# CI에서도 stdin 없이 release 가능.
#
# 사전 등록 (외부 터미널에서 한 번):
#   security add-generic-password -s flipmd-minisign -a "$USER" -w
#   (프롬프트에서 비밀번호 입력)
#
# Usage:
#   scripts/release-flipmd.sh --version 1.3.11 --upload
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

# .env 자동 로드 (gitignore 됨). 우선순위: 기존 환경변수 > .env.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-flipmd-minisign}"
KEYCHAIN_ACCOUNT="${KEYCHAIN_ACCOUNT:-$USER}"

# `set` 여부로 판정 — 빈 string("")도 의도된 빈 비번으로 수용한다.
# 진짜 unset일 때만 keychain / prompt fallback.
if [[ -z "${MINISIGN_PASSWORD+set}" ]]; then
  if MP=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w 2>/dev/null); then
    MINISIGN_PASSWORD="$MP"
  elif [[ -t 0 ]]; then
    read -sp "minisign password: " MINISIGN_PASSWORD
    echo
  else
    echo "✗ MINISIGN_PASSWORD 없음. .env에 등록하거나 환경변수로 전달하세요." >&2
    exit 1
  fi
fi

export MINISIGN_SECRET_KEY="${MINISIGN_SECRET_KEY:-$HOME/.tauri/flipmd.key}"
export MINISIGN_PASSWORD
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: YONGSUB LEE (XU8HS9JUTS)}"
export RELEASE_NOTES="${RELEASE_NOTES:-FlipMD release}"

exec scripts/release.sh "$@"
