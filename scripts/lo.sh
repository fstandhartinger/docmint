#!/usr/bin/env bash
# Convert an Office file with headless LibreOffice, for VERIFYING output.
#   scripts/lo.sh pdf  out/invoice.docx        -> out/invoice.pdf
#   scripts/lo.sh txt  out/invoice.docx        -> out/invoice.txt
#   scripts/lo.sh csv  out/report.xlsx         -> out/report.csv
#   scripts/lo.sh --ensure                   -> exit 0 when the probe image is usable (building it if needed)
# Uses the docmint-lo-probe image because LibreOffice is not installed on this host.
# The host's cleanup jobs prune the image at any hour: build it on demand.
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=docmint-lo-probe
LOCK=/tmp/docmint-lo-probe.build.lock

ensure_image() {
  sudo -n docker image inspect "$IMAGE" >/dev/null 2>&1 && return 0
  # The host's cleanup jobs prune the image at any hour. Rebuild under a lock so
  # parallel test workers do not build it twice; the lock holder builds once,
  # everyone else then proceeds through the inspect above.
  (
    flock -w 600 9
    sudo -n docker image inspect "$IMAGE" >/dev/null 2>&1 && exit 0
    sudo -n docker build -t "$IMAGE" -f ops/lo-probe.Dockerfile . >/dev/null
  ) 9>"$LOCK"
  sudo -n docker image inspect "$IMAGE" >/dev/null 2>&1
}

if [ "${1:-}" = "--ensure" ]; then
  ensure_image
  exit 0
fi

fmt="$1"; shift
f="$(readlink -f "$1")"
d="$(dirname "$f")"; b="$(basename "$f")"
case "$fmt" in
  txt)  filter="txt:Text (encoded):UTF8" ;;
  csv)  filter="csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true" ;;
  *)    filter="$fmt" ;;
esac
ensure_image
sudo -n docker run --rm -m 512m -v "$d:/w" -e HOME=/tmp "$IMAGE" \
  soffice --headless --norestore --convert-to "$filter" --outdir /w "/w/$b" >/dev/null 2>&1
echo "$d/${b%.*}.$fmt"
