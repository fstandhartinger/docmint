#!/usr/bin/env bash
#
# Builds the DOCX test fixtures with LibreOffice.
#
# Why not hand-written document.xml: a fixture the renderer's own author typed is a
# fixture that agrees with the renderer's assumptions. Real templates come out of
# Word or LibreOffice and carry things nobody writes by hand — <w:pPr> before every
# run, empty <w:rPr></w:rPr> pairs, styles referenced by name, a <w:sectPr> at the
# end of the body, headers and footers in their own parts with their own rels. So
# the templates are authored as flat ODF (.fodt, which is diffable and lives in
# git) and converted by LibreOffice into the .docx the tests actually load.
#
#   fixtures/make-docx-fixtures.sh
#
# Requires the docmint-lo-probe image (LibreOffice is not installed on the host).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

for f in "$here"/src/*.fodt; do
  b="$(basename "$f" .fodt)"
  sudo docker run --rm -m 1g -v "$here:/w" -e HOME=/tmp docmint-lo-probe \
    soffice --headless --norestore --convert-to docx --outdir /w "/w/src/$b.fodt" >/dev/null 2>&1
  sudo chown "$(id -u):$(id -g)" "$here/$b.docx"
  echo "$b.docx"
done

# The split-run case cannot be produced by LibreOffice, which keeps each
# placeholder in one run. It is the single most important thing to get right, so
# the fixture is manufactured: see fixtures/split-runs.js.
node "$here/split-runs.js" "$here/invoice.docx" "$here/split-runs.docx"
