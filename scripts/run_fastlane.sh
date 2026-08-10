#!/usr/bin/env bash
set -euo pipefail

REPO_PATH=${1:?'Missing repository path'}
FASTLANE_LANE=${2:?'Missing Fastlane lane'}
BUILD_NUMBER=${3:?'Missing build number'}
RELEASE_NOTES=${4:-''}
SCHEME=${5:-''}
BUILD_CONFIGURATION=${6:-''}
FIREBASE_APP_ID=${7:-''}
FIREBASE_GROUPS=${8:-''}
APP_VERSION=${9:-''}

if [[ ! -d "$REPO_PATH" ]]; then
  printf 'iOS repository does not exist: %s\n' "$REPO_PATH" >&2
  exit 2
fi

cd -- "$REPO_PATH"

if [[ ! -f Gemfile || ! -f fastlane/Fastfile ]]; then
  printf 'Repository must contain Gemfile and fastlane/Fastfile\n' >&2
  exit 2
fi

FASTLANE_ARGS=(
  "$FASTLANE_LANE"
  "build_number:$BUILD_NUMBER"
  "release_notes:$RELEASE_NOTES"
)

if [[ -n "$APP_VERSION" ]]; then
  FASTLANE_ARGS+=("app_version:$APP_VERSION")
fi

if [[ -n "$SCHEME" ]]; then
  FASTLANE_ARGS+=("scheme:$SCHEME")
fi

if [[ -n "$BUILD_CONFIGURATION" ]]; then
  FASTLANE_ARGS+=("configuration:$BUILD_CONFIGURATION")
fi

if [[ -n "$FIREBASE_APP_ID" ]]; then
  FASTLANE_ARGS+=("firebase_app_id:$FIREBASE_APP_ID")
fi

if [[ -n "$FIREBASE_GROUPS" ]]; then
  FASTLANE_ARGS+=("firebase_groups:$FIREBASE_GROUPS")
fi

BUNDLE_EXECUTABLE=${BUNDLE_BIN:-bundle}
exec "$BUNDLE_EXECUTABLE" exec fastlane "${FASTLANE_ARGS[@]}"
