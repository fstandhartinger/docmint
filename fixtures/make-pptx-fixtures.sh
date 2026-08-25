#!/usr/bin/env bash
#
# Regenerates the .pptx template fixtures used by test/pptx.test.js.
#
# The decks are authored as flat-ODF presentations and converted by LibreOffice
# Impress, deliberately: a fixture hand-written as PresentationML would be a
# fixture written to suit our own parser, and would keep passing after a change
# that breaks every real template. What comes out of Impress has the shapes,
# the placeholder ids, the table structure and — where the .fodp asks for it —
# the split text runs that a real deck has.
#
# Needs the docmint-lo-probe image (see ops/lo-probe.Dockerfile):
#   sudo docker build -t docmint-lo-probe -f ops/lo-probe.Dockerfile .
#
# Usage:  fixtures/make-pptx-fixtures.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

hdr() {
cat <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.2"
  office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:style style:name="gr1" style:family="graphic"/>
  <style:style style:name="Tbold" style:family="text">
   <style:text-properties fo:font-weight="bold"/>
  </style:style>
  <style:style style:name="Tital" style:family="text">
   <style:text-properties fo:font-style="italic"/>
  </style:style>
 </office:automatic-styles>
 <office:body>
  <office:presentation>
XML
}

ftr() {
cat <<'XML'
  </office:presentation>
 </office:body>
</office:document>
XML
}

# ---------------------------------------------------------------------------
# report.pptx — title values (with split runs), an image placeholder shape,
# a table with a row loop, a paragraph loop, an inverted section, and notes.
# ---------------------------------------------------------------------------
{
hdr
cat <<'XML'
   <draw:page draw:name="Cover">
    <draw:frame draw:name="Title 1" draw:style-name="gr1" svg:x="1.5cm" svg:y="2cm" svg:width="22cm" svg:height="2.5cm">
     <draw:text-box><text:p>{ti<text:span text:style-name="Tbold">tle</text:span>}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Subtitle 2" draw:style-name="gr1" svg:x="1.5cm" svg:y="5cm" svg:width="22cm" svg:height="2cm">
     <draw:text-box><text:p>{sub<text:span text:style-name="Tital">title</text:span>} for {client.name}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Logo 3" draw:style-name="gr1" svg:x="20cm" svg:y="8cm" svg:width="4cm" svg:height="4cm">
     <draw:text-box><text:p>{%logo}</text:p></draw:text-box>
    </draw:frame>
    <presentation:notes>
     <draw:frame draw:name="Notes 1" svg:x="2cm" svg:y="10cm" svg:width="14cm" svg:height="6cm">
      <draw:text-box><text:p>Talk track for {title}: {notes}</text:p></draw:text-box>
     </draw:frame>
    </presentation:notes>
   </draw:page>
   <draw:page draw:name="Numbers">
    <draw:frame draw:name="Heading 4" draw:style-name="gr1" svg:x="1.5cm" svg:y="0.8cm" svg:width="22cm" svg:height="1.5cm">
     <draw:text-box><text:p>Line items for {client.name}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Items 5" svg:x="1.5cm" svg:y="2.5cm" svg:width="22cm" svg:height="6cm">
     <table:table>
      <table:table-column table:number-columns-repeated="3"/>
      <table:table-row>
       <table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>Qty</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>Amount</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
       <table:table-cell office:value-type="string"><text:p>{#rows}{sk<text:span text:style-name="Tbold">u</text:span>}</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{qty}</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{amount|currency:EUR}{/rows}</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
       <table:table-cell office:value-type="string"><text:p>Total</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{rows|count}</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{rows|sum:amount|currency:EUR}</text:p></table:table-cell>
      </table:table-row>
     </table:table>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Bullets">
    <draw:frame draw:name="Body 6" draw:style-name="gr1" svg:x="1.5cm" svg:y="1.5cm" svg:width="22cm" svg:height="10cm">
     <draw:text-box>
      <text:p>Findings</text:p>
      <text:p>{#findings}</text:p>
      <text:p>{$index1}. {label} - {detail}</text:p>
      <text:p>{/findings}</text:p>
      <text:p>{^findings}Nothing to report.{/findings}</text:p>
      <text:p>Owners: {#findings}{owner}{^$last}, {/}{/findings}</text:p>
     </draw:text-box>
    </draw:frame>
   </draw:page>
XML
ftr
} > "$work/report.fodp"

# ---------------------------------------------------------------------------
# chapters.pptx — a slide loop spanning several slides. The {#chapters} and
# {/chapters} markers each sit alone in their own text box on a slide of their
# own, so the two marker slides vanish and the two slides between them repeat.
# ---------------------------------------------------------------------------
{
hdr
cat <<'XML'
   <draw:page draw:name="Intro">
    <draw:frame draw:name="Title 1" draw:style-name="gr1" svg:x="1.5cm" svg:y="3cm" svg:width="22cm" svg:height="3cm">
     <draw:text-box><text:p>{deck}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="LoopOpen">
    <draw:frame draw:name="Marker Open" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="6cm" svg:height="1cm">
     <draw:text-box><text:p>{#chapters}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="ChapterTitle">
    <draw:frame draw:name="Chapter Heading" draw:style-name="gr1" svg:x="1.5cm" svg:y="3cm" svg:width="22cm" svg:height="3cm">
     <draw:text-box><text:p>Chapter {$index1} of {$length}: {name}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Deck Ref" draw:style-name="gr1" svg:x="1.5cm" svg:y="7cm" svg:width="22cm" svg:height="1.5cm">
     <draw:text-box><text:p>{deck}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="ChapterDetail">
    <draw:frame draw:name="Detail Body" draw:style-name="gr1" svg:x="1.5cm" svg:y="2cm" svg:width="22cm" svg:height="8cm">
     <draw:text-box>
      <text:p>{name} details</text:p>
      <text:p>{#points}</text:p>
      <text:p>- {.}</text:p>
      <text:p>{/points}</text:p>
     </draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="LoopClose">
    <draw:frame draw:name="Marker Close" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="6cm" svg:height="1cm">
     <draw:text-box><text:p>{/chapters}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Outro">
    <draw:frame draw:name="End 9" draw:style-name="gr1" svg:x="1.5cm" svg:y="3cm" svg:width="22cm" svg:height="3cm">
     <draw:text-box><text:p>End of {deck}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
XML
ftr
} > "$work/chapters.fodp"

# ---------------------------------------------------------------------------
# cards.pptx — the single-slide form: {#cards} and {/cards} alone in their own
# shapes on the SAME slide, so that one slide repeats per array element.
# ---------------------------------------------------------------------------
{
hdr
cat <<'XML'
   <draw:page draw:name="Cover">
    <draw:frame draw:name="Title 1" draw:style-name="gr1" svg:x="1.5cm" svg:y="3cm" svg:width="22cm" svg:height="3cm">
     <draw:text-box><text:p>{title}</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Card">
    <draw:frame draw:name="Loop Open" draw:style-name="gr1" svg:x="0.5cm" svg:y="0.5cm" svg:width="5cm" svg:height="0.8cm">
     <draw:text-box><text:p>{#cards}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Card Heading" draw:style-name="gr1" svg:x="1.5cm" svg:y="3cm" svg:width="22cm" svg:height="2.5cm">
     <draw:text-box><text:p>{label}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Card Body" draw:style-name="gr1" svg:x="1.5cm" svg:y="6cm" svg:width="22cm" svg:height="4cm">
     <draw:text-box><text:p>{body}</text:p><text:p>Card {$index1} of {$length} in {title}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Loop Close" draw:style-name="gr1" svg:x="0.5cm" svg:y="12cm" svg:width="5cm" svg:height="0.8cm">
     <draw:text-box><text:p>{/cards}</text:p></draw:text-box>
    </draw:frame>
    <presentation:notes>
     <draw:frame draw:name="Card Notes" svg:x="2cm" svg:y="10cm" svg:width="14cm" svg:height="6cm">
      <draw:text-box><text:p>Speaker notes for {label}</text:p></draw:text-box>
     </draw:frame>
    </presentation:notes>
   </draw:page>
XML
ftr
} > "$work/cards.fodp"

# ---------------------------------------------------------------------------
# nested.pptx — three levels of nesting both across paragraphs and inline,
# inverted sections in every position, outward scope with ../, a multi-line
# value, raw OOXML, a comment tag and an image tag sharing a shape with text.
# ---------------------------------------------------------------------------
{
hdr
cat <<'XML'
   <draw:page draw:name="Nesting">
    <draw:frame draw:name="Deep 1" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="13cm" svg:height="12cm">
     <draw:text-box>
      <text:p>{#regions}</text:p>
      <text:p>{name}</text:p>
      <text:p>{#offices}</text:p>
      <text:p>{city}:</text:p>
      <text:p>{#staff}</text:p>
      <text:p>- {.} ({../city}, {../../name})</text:p>
      <text:p>{/staff}</text:p>
      <text:p>{/offices}</text:p>
      <text:p>{/regions}</text:p>
     </draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Inline 2" draw:style-name="gr1" svg:x="14cm" svg:y="1cm" svg:width="12cm" svg:height="4cm">
     <draw:text-box><text:p>[{#regions}{name}({#offices}{city}{^$last}; {/}{/offices}){^$last} | {/}{/regions}]</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Inverted 3" draw:style-name="gr1" svg:x="14cm" svg:y="6cm" svg:width="12cm" svg:height="4cm">
     <draw:text-box>
      <text:p>{^regions}no regions at all{/regions}</text:p>
      <text:p>{^ghosts}no ghosts here{/ghosts}</text:p>
     </draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Bits">
    <draw:frame draw:name="Multiline 4" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="12cm" svg:height="4cm">
     <draw:text-box><text:p>Address: {address}</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Raw 5" draw:style-name="gr1" svg:x="1cm" svg:y="6cm" svg:width="12cm" svg:height="2cm">
     <draw:text-box><text:p>Before {@rawrun} after</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="Comment 6" draw:style-name="gr1" svg:x="14cm" svg:y="1cm" svg:width="12cm" svg:height="2cm">
     <draw:text-box><text:p>Kept{!this vanishes} text</text:p></draw:text-box>
    </draw:frame>
    <draw:frame draw:name="InlineImage 7" draw:style-name="gr1" svg:x="14cm" svg:y="6cm" svg:width="12cm" svg:height="4cm">
     <draw:text-box><text:p>Logo: {%pic} here</text:p></draw:text-box>
    </draw:frame>
   </draw:page>
   <draw:page draw:name="Grid">
    <draw:frame draw:name="Grid 8" svg:x="1cm" svg:y="2cm" svg:width="24cm" svg:height="8cm">
     <table:table>
      <table:table-column table:number-columns-repeated="3"/>
      <table:table-row>
       <table:table-cell office:value-type="string"><text:p>Region</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>Offices</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>Count</text:p></table:table-cell>
      </table:table-row>
      <table:table-row>
       <table:table-cell office:value-type="string"><text:p>{#regions}{name}</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{#offices}{city}{^$last}, {/}{/offices}</text:p></table:table-cell>
       <table:table-cell office:value-type="string"><text:p>{offices|count}{/regions}</text:p></table:table-cell>
      </table:table-row>
     </table:table>
    </draw:frame>
   </draw:page>
XML
ftr
} > "$work/nested.fodp"

sudo docker run --rm -m 1g -v "$work:/w" -e HOME=/tmp docmint-lo-probe \
  soffice --headless --norestore --convert-to pptx --outdir /w \
  /w/report.fodp /w/chapters.fodp /w/cards.fodp /w/nested.fodp >/dev/null 2>&1

for f in report chapters cards nested; do
  sudo chown "$(id -u):$(id -g)" "$work/$f.pptx"
  cp "$work/$f.pptx" "$here/$f.pptx"
  cp "$work/$f.fodp" "$here/$f.fodp"
  echo "wrote fixtures/$f.pptx ($(stat -c%s "$here/$f.pptx") bytes)"
done
