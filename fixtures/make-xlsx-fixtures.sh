#!/usr/bin/env bash
#
# Builds the XLSX test fixtures with LibreOffice.
#
# Why not hand-written sheet XML: a fixture the renderer's own author typed is a
# fixture that happens to match the renderer's assumptions. Real templates come
# out of Excel or LibreOffice and carry things a hand-rolled fixture never has —
# shared strings that are reused by two cells, rich-text <r><t> runs splitting a
# placeholder in half, t="n" on numeric cells, formulas with cached values,
# merged ranges, a dimension that has to stay in step. So the fixtures are
# authored as flat ODF (.fods, which is diffable and lives in git) and converted
# by LibreOffice into the .xlsx the tests actually load.
#
#   fixtures/make-xlsx-fixtures.sh
#
# Requires the docmint-lo-probe image (LibreOffice is not installed on the host).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/src"

for f in "$src"/*.fods; do
  b="$(basename "$f" .fods)"
  sudo docker run --rm -m 1g -v "$here:/w" -e HOME=/tmp docmint-lo-probe \
    soffice --headless --norestore --convert-to xlsx --outdir /w "/w/src/$b.fods" >/dev/null 2>&1
  sudo chown "$(id -u):$(id -g)" "$here/$b.xlsx"
  echo "$b.xlsx"
done

# LibreOffice never writes shared formulas (<f t="shared" ref=... si=...>), but
# Excel writes them for any column of copied formulas — which is exactly what an
# invoice line-item column is. So one fixture is post-processed to carry a real
# shared-formula group, the way Excel would have saved it.
node "$here/shared-formula.js" "$here/shared-formula.xlsx"
echo "shared-formula.xlsx (shared <f> group injected)"
