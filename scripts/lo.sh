#!/usr/bin/env bash
# Convert an Office file with headless LibreOffice, for VERIFYING output.
#   scripts/lo.sh pdf  out/invoice.docx        -> out/invoice.pdf
#   scripts/lo.sh txt  out/invoice.docx        -> out/invoice.txt
#   scripts/lo.sh csv  out/report.xlsx         -> out/report.csv
# Uses the docmint-lo-probe image because LibreOffice is not installed on this host.
set -euo pipefail
fmt="$1"; shift
f="$(readlink -f "$1")"
d="$(dirname "$f")"; b="$(basename "$f")"
case "$fmt" in
  txt)  filter="txt:Text (encoded):UTF8" ;;
  csv)  filter="csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true" ;;
  *)    filter="$fmt" ;;
esac
sudo docker run --rm -m 512m -v "$d:/w" -e HOME=/tmp docmint-lo-probe \
  soffice --headless --norestore --convert-to "$filter" --outdir /w "/w/$b" >/dev/null 2>&1
echo "$d/${b%.*}.$fmt"
