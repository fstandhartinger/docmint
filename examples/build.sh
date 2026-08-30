#!/usr/bin/env bash
#
# Rebuilds the three example templates from their flat-ODF sources, fills them
# with the sample data, converts the results to PDF, checks every number that
# appears in them and writes the page images used on the landing page.
#
#   examples/build.sh            build, fill and verify everything
#   examples/build.sh --no-image do not (re)build the LibreOffice image
#
# Why flat ODF and not hand-written OOXML: a template written by the renderer's
# own author is a template that agrees with the renderer's assumptions. These
# come out of LibreOffice with styles referenced by name, <w:pPr> before every
# run, headers and footers in their own parts, a sectPr at the end of the body,
# and a shared string table - which is what a template exported from Office
# looks like, and what the renderer has to survive.
#
# LibreOffice is not installed on the host; it lives in the docmint-lo-probe
# image (ops/lo-probe.Dockerfile). That image has neither the metric-compatible
# Office fonts nor poppler, so this script derives a small image from it that
# has both. Carlito and Caladea matter: they are metric-compatible with Calibri
# and Cambria, which is what the production Dockerfile installs, so what the PDF
# looks like here is what it looks like in production.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
IMAGE=docmint-lo-examples
BASE=docmint-lo-probe

lo() { sudo docker run --rm -m 1g -v "$here:/w" -e HOME=/tmp "$IMAGE" "$@"; }
own() { sudo chown "$(id -u):$(id -g)" "$@"; }

if [ "${1:-}" != "--no-image" ]; then
  if ! sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "building $IMAGE (LibreOffice + Carlito/Caladea + poppler)..."
    sudo docker image inspect "$BASE" >/dev/null 2>&1 || {
      echo "missing $BASE. Build it first:" >&2
      echo "  sudo docker build -t $BASE -f ops/lo-probe.Dockerfile ." >&2
      exit 1
    }
    sudo docker build -t "$IMAGE" - <<'DOCKERFILE'
FROM docmint-lo-probe
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      fonts-crosextra-carlito fonts-crosextra-caladea poppler-utils \
 && fc-cache -f \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
DOCKERFILE
  fi
fi

echo "== logo"
node "$here/src/make-logo.js"

echo "== templates"
lo soffice --headless --norestore --convert-to docx --outdir /w /w/src/invoice.fodt      >/dev/null 2>&1
lo soffice --headless --norestore --convert-to xlsx --outdir /w /w/src/sales-report.fods >/dev/null 2>&1
lo soffice --headless --norestore --convert-to pptx --outdir /w /w/src/quarterly-deck.fodp >/dev/null 2>&1
own "$here/invoice.docx" "$here/sales-report.xlsx" "$here/quarterly-deck.pptx"

# Two things LibreOffice will not carry from flat ODF into OOXML. Both are
# explained in the scripts themselves.
node "$here/src/freeze-panes.js"     "$here/sales-report.xlsx" 5 4
node "$here/src/style-deck-table.js" "$here/quarterly-deck.pptx" ppt/slides/slide2.xml

for f in invoice.docx sales-report.xlsx quarterly-deck.pptx; do
  printf '   %-22s %8s bytes\n' "$f" "$(stat -c%s "$here/$f")"
done

echo "== fill, convert and verify"
node "$here/verify.js"
