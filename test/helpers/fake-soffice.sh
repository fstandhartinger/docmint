#!/bin/sh
# Test double for LibreOffice (point SOFFICE_BIN here). Faithful to the two
# behaviours the real converter has that these suites depend on: it echoes its
# own argv to stderr (which is how a failing soffice can leak the password
# inside the filter options — the redaction tests rely on it), and it encrypts
# only when the --convert-to options asked for it, so the /Encrypt trailer
# appears exactly when a password was in play.
#
# Output: a minimal one-trailer PDF in <outdir>/doc.pdf carrying /Encrypt when
# the argv carried DocumentOpenPassword.
#
# Failure injection, for the fail-closed and refund paths:
#   mode "noencrypt"  writes the PDF but drops /Encrypt even when asked
#   mode "fail"       exits non-zero before writing anything
#   anything else     behaves like the real converter on a good day
# The mode comes from DOCMINT_FAKE_MODE when that is set (the unit suite
# drives it that way); else from the DOCMINT_FAKE_CTRL file when one is
# readable (so a running server can be switched between good and failing
# conversions without restarting it); else "ok".
echo "$@" >&2
mode="${DOCMINT_FAKE_MODE:-}"
if [ -z "$mode" ] && [ -n "${DOCMINT_FAKE_CTRL:-}" ] && [ -r "$DOCMINT_FAKE_CTRL" ]; then
  mode="$(cat "$DOCMINT_FAKE_CTRL" 2>/dev/null)"
fi
mode="${mode:-ok}"
out=""
prev=""
encrypted=0
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  case "$a" in *DocumentOpenPassword*) encrypted=1 ;; esac
  prev="$a"
done
if [ "$mode" = "fail" ]; then
  exit 3
fi
if [ -n "$out" ]; then
  if [ "$mode" = "noencrypt" ]; then
    encrypted=0
  fi
  if [ "$encrypted" = 1 ]; then
    printf '%%PDF-1.7\ntrailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\nstartxref\n0\n%%%%EOF\n' > "$out/doc.pdf"
  else
    printf '%%PDF-1.7\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%%%EOF\n' > "$out/doc.pdf"
  fi
fi
exit 0
