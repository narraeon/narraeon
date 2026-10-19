#!/usr/bin/env bash
# Fetches the pinned digidem/nodejs-mobile release and extracts the arm64-v8a
# libnode.so and Node headers into android/app/libnode/. Idempotent: skips the
# download when the extracted VERSION marker already matches.
set -euo pipefail

NODEJS_MOBILE_VERSION="24.20.0-0"
ZIP_NAME="nodejs-mobile-android-${NODEJS_MOBILE_VERSION}.zip"
ZIP_URL="https://github.com/digidem/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VERSION}/${ZIP_NAME}"
ZIP_SHA256="f5ffbaf4f2679fa9180b0758c637c2f8fc8828300f95129badf213a028fb37bb"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
libnode_dir="${script_dir}/../app/libnode"

if [[ -f "${libnode_dir}/VERSION" ]] &&
  [[ "$(cat "${libnode_dir}/VERSION")" == "${NODEJS_MOBILE_VERSION}" ]]; then
  echo "libnode ${NODEJS_MOBILE_VERSION} already present in ${libnode_dir}"
  exit 0
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT

curl --fail --location --silent --show-error \
  --output "${work_dir}/${ZIP_NAME}" "${ZIP_URL}"

echo "${ZIP_SHA256}  ${work_dir}/${ZIP_NAME}" | shasum -a 256 -c -

mkdir "${work_dir}/extract"
unzip -q "${work_dir}/${ZIP_NAME}" \
  "bin/arm64-v8a/libnode.so" "include/node/*" -d "${work_dir}/extract"

rm -rf "${libnode_dir}"
mkdir -p "${libnode_dir}/bin/arm64-v8a" "${libnode_dir}/include"
cp "${work_dir}/extract/bin/arm64-v8a/libnode.so" \
  "${libnode_dir}/bin/arm64-v8a/libnode.so"
cp -R "${work_dir}/extract/include/node" "${libnode_dir}/include/node"
echo "${NODEJS_MOBILE_VERSION}" >"${libnode_dir}/VERSION"

echo "libnode ${NODEJS_MOBILE_VERSION} extracted to ${libnode_dir}"
