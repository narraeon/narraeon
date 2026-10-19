# Narraeon Android

The Android app embeds the Narraeon backend in its own process. A foreground service starts
the Node runtime (digidem/nodejs-mobile `libnode.so`, Node 24.20.0), and a WebView opens
`http://127.0.0.1:4317`. Only `arm64-v8a` is supported. See
[ADR-0045](../docs/adr/0045-android-embeds-backend-in-app-process.md).

## Prerequisites

- JDK 17
- Android SDK with platform 34 and build-tools 34
- NDK 26.3.11579264 with CMake 3.22.1 (install through the SDK manager)
- Node.js 24.12 or later, for the bundle build

## Build

Run these from the repository root.

```bash
npm ci
npm run build:android
./android/scripts/fetch-libnode.sh
cd android
./gradlew assembleDebug
```

1. `npm run build:android` builds the backend and web app, then stages them into
   `android/app/src/main/assets/narraeon/` (`node/`, `web/`, `node_modules/`,
   `package.json`, `bundle-version.txt`). The folder is generated and is not committed.
2. `fetch-libnode.sh` downloads the pinned nodejs-mobile release zip, checks its sha256,
   and extracts `libnode/bin/arm64-v8a/libnode.so` and `libnode/include/node/` into
   `android/app/libnode/`. The folder is generated and is not committed.
3. `./gradlew assembleDebug` builds the APK at `app/build/outputs/apk/debug/`.

The wrapper is not checked in yet. Generate it once with a local Gradle install
(`gradle wrapper --gradle-version 8.9`), or open `android/` in Android Studio.

## Runtime layout

On first launch, and whenever `bundle-version.txt` changes, `NodeService` copies
`assets/narraeon/` into `filesDir/narraeon/`. User data stays in `filesDir/data`,
`filesDir/config` and `filesDir/log`, which upgrades do not touch.

## Logs

```bash
adb logcat -s NARRAEON-NODE NARRAEON-SERVICE
```

Node stdout and stderr appear under `NARRAEON-NODE`. The mobile entry prints
`NARRAEON_READY <port>` once the server is listening.
