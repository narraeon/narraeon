# Narraeon Android

The Android app embeds the Narraeon backend in its own process. A foreground service starts
the Node runtime (digidem/nodejs-mobile `libnode.so`, Node 24.20.0), and a WebView opens
`http://127.0.0.1:4317`. Only `arm64-v8a` is supported. See
[ADR-0047](../docs/adr/0047-android-embeds-backend-in-app-process.md).

## Prerequisites

- JDK 17
- Android SDK with platform 34 and build-tools 34
- NDK 26.3.11579264 with CMake 3.22.1 (install through the SDK manager)
- Node.js 24.12 or later, for the bundle build
- Known limit: Android 15 (API 35) caps `dataSync` foreground services at 6 hours per day.
  The current `targetSdk` is 34 and is not affected. Raising `targetSdk` to 35 or later needs
  a different foreground service type or a different way to keep the backend running.

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

The Gradle wrapper (8.9) is checked in, so no separate Gradle install is needed. Open
`android/` in Android Studio, or use `./gradlew` as shown above.

## Runtime layout

On first launch, and whenever `bundle-version.txt` changes, `NodeService` copies
`assets/narraeon/` into `filesDir/narraeon/`. User data stays in `filesDir/data`,
`filesDir/config` and `filesDir/log`, which upgrades do not touch. The marker reads
`<version>+<commit>.<content hash>`, so a rebuild with uncommitted changes is also
recopied.

## Background running

The foreground service keeps the process alive when the app leaves the screen, and it
holds a partial wake lock while Node runs, so the CPU keeps serving requests with the
screen off. The wake lock also keeps the device out of deep sleep while the app is idle.
The service notification opens the app when tapped, and its **Exit** action releases the
wake lock and ends the process. On Android 13 and later the app asks for the notification
permission at launch; if it is denied, the service still runs but the notification and its
Exit action stay hidden. Vendor ROMs that kill background apps despite a foreground
service are not handled.

## Logs

```bash
adb logcat -s NARRAEON-NODE NARRAEON-SERVICE
```

Node stdout and stderr appear under `NARRAEON-NODE`. The mobile entry prints
`NARRAEON_READY <port>` once the server is listening.

## File inputs

`<input type="file">` opens the system document picker (`ACTION_OPEN_DOCUMENT`). The
picker shows all file types, because the pages' `accept` lists mix extensions and MIME
types and file managers often label a `.zip` as `application/octet-stream`. The backend
validates whatever is chosen.

## File exports

The WebView ignores `<a download>`. Inside the app, `saveFile` in
`src/web/androidBridge.ts` sends a `save-file` message to `WebFileSaver` instead: small
files go as base64, and world backups go as a same-origin path that the native side
streams from the backend. `WebFileSaver` opens the system save dialog, writes the file,
and replies `saved`, `cancelled` or `failed` to the page. Browsers keep the normal
download.

## Crash handling and diagnostic export

The app keeps its own crash records in `filesDir/log/crash/`, so users can send logs
without adb:

- `node-errors.log`: uncaught exceptions and unhandled rejections in Node. The mobile
  entry records them and keeps serving, because Node calling `exit()` would close the
  whole app.
- `node-stderr.log`: a copy of Node stderr written by the native layer (1 MB, then
  rotated to `.1`). It keeps fatal V8 errors that end the process.
- `java-crash.log`, `webview.log`, `webview-console.log`, `node-service.log`: JVM
  crashes, WebView renderer deaths, page console errors, and Node start/exit.
- `exit-reasons.log` (Android 11+): why earlier app processes ended, with ANR traces and
  native tombstones when Android keeps them.

If the WebView renderer dies, the app rebuilds the WebView and reloads it instead of
being killed. After three renderer deaths within a minute, or when Node stops, the app
shows a native screen with **Export diagnostic logs** and **Close app**. After an
abnormal exit (crash, native crash, ANR, Node exit, fatal signal, or a low-memory kill
while on screen) the next launch offers an export.

**Export diagnostic logs** is also in the ☰ menu. It zips a device report, this app's
logcat, `log/crash/`, and the last 7 days of `log/runtime-errors/`, then opens the share
sheet. `log/ai-failures/` is left out because it can hold world text sent to the model.

## Release APK in CI

Published GitHub Releases build and attach the arm64 release APK automatically.
Version, signing, and the attachment name are described in
[RELEASING.md](../RELEASING.md#android-apk).
