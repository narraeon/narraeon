#!/usr/bin/env bash
# Runs the JNI regression checks on an arm64 Android device or emulator.
set -euo pipefail

serial=${1:?Usage: test-native-startup.sh ANDROID_SERIAL [LEGACY_NATIVE_SOURCE]}
android_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source=${2:-"$android_dir/app/src/main/cpp/native-lib.cpp"}
sdk=${ANDROID_SDK_ROOT:-${ANDROID_HOME:?Set ANDROID_SDK_ROOT or ANDROID_HOME}}
ndk=${ANDROID_NDK_HOME:-"$sdk/ndk/26.3.11579264"}
compiler=("$ndk"/toolchains/llvm/prebuilt/*/bin/aarch64-linux-android24-clang++)
work_dir=$(mktemp -d)
device_path=/data/local/tmp/narraeon-native-startup-test-$$
trap 'adb -s "$serial" shell rm -f "$device_path" >/dev/null; rm -rf "$work_dir"' EXIT

"${compiler[0]}" -std=c++20 -static-libstdc++ \
  -I"$android_dir/app/libnode/include/node" \
  -Wl,--wrap=pipe,--wrap=pipe2,--wrap=dup2,--wrap=pthread_create \
  "$source" "$android_dir/app/src/test/cpp/native-startup-test.cpp" -llog \
  -o "$work_dir/native-startup-test"
adb -s "$serial" push "$work_dir/native-startup-test" "$device_path" >/dev/null
for scenario in success pipe dup2 pthread_create; do
  if [[ $# == 2 ]]; then
    if adb -s "$serial" shell NARRAEON_252_LEGACY=1 "$device_path" "$scenario"; then
      echo "Unexpected baseline pass [$scenario]" >&2
      exit 1
    else
      result=$?
      [[ $result == 1 ]]
      echo "Reproduced baseline failure [$scenario]"
    fi
  else
    adb -s "$serial" shell "$device_path" "$scenario"
  fi
done
