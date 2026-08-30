# DocMint examples

Three finished templates, the sample data that fills them, and the images of what
comes out. They are meant to be opened, read and copied — not just looked at.

| Template | Data | What it shows |
|---|---|---|
| `invoice.docx` | `invoice.data.json` | letterhead with an image placeholder, a bordered line-item table driven by a row loop, a totals block computed entirely by formatters, a conditional PAID / OVERDUE banner, and the invoice number in the running header and footer |
| `sales-report.xlsx` | `sales-report.data.json` | a row loop that expands one template row into twelve, real Excel number formats so the filled values are numbers, `SUM()` and `INDEX/MATCH` that still point at the right range afterwards, a frozen header row, banded rows, and a second sheet with a cross-sheet consistency check |
| `quarterly-deck.pptx` | `quarterly-deck.data.json` | a title slide, a table whose rows repeat per array element, and a slide loop that turns one template slide into one slide per region — each with its own speaker notes |

Page images: `invoice.png`, `sales-report.png`, `sales-report-summary.png`,
`quarterly-deck.png`, `quarterly-deck-table.png`, `quarterly-deck-region.png`.

The sources are in `src/`: the templates are written as flat ODF (`.fodt`,
`.fods`, `.fodp`) and converted by LibreOffice, so the `.docx`, `.xlsx` and
`.pptx` in this folder have the shape a file exported from Office has — styles
referenced by name, headers and footers in their own parts, a shared string
table — rather than the shape a renderer's own author would hand-write.

## Rebuilding everything

```sh
examples/build.sh
```

That regenerates `logo.png`, converts the three flat-ODF sources, applies two
small post-steps (below), then fills every template, converts the results to PDF
and CSV, checks every number in them and writes the page images. It needs Docker
and the `docmint-lo-probe` image (`ops/lo-probe.Dockerfile`); it derives its own
image from that with Carlito, Caladea and poppler added. Carlito and Caladea are
the metric-compatible substitutes for Calibri and Cambria that the production
Dockerfile installs, so the PDFs it renders match what the service produces.

The last line of a successful run is the number of checks that passed. At the
time of writing:

```
-- invoice.docx
   subtotal €26,854.00  VAT 21% €5,639.34  total €32,493.34
   47 tags, 46 resolved, 3 sections, 1 image, 1 page

-- sales-report.xlsx
   12 rows expanded; SUM(revenue) €542,778.00, SUM(units) 14,300, growth 7.0%, shares 100.0%
   summary: 6 regions, top DACH, cross-sheet check "Yes"

-- quarterly-deck.pptx
   9 slides, 9 notes slides, 210 tags all resolved
   scorecard total €1,618,440.00 / 44,460 units / 8.4%

-- result
   258 checks passed
```

`verify.js` recomputes every figure from the sample data in plain JavaScript and
asserts the formatted string is present in the rendered PDF or CSV. It does not
trust the template's own arithmetic — that is the thing being tested.

## 1. invoice.docx

A one-page commercial invoice for a fictional Dutch instrument supplier.

The totals are not in the data and not in the template. They are computed from
the line items when the document is filled:

```
Subtotal (net)   {items|sumProduct:qty:unit_price|currency:EUR}
VAT at {vat_rate|percent}   {items|sumProduct:qty:unit_price:vat_rate|currency:EUR}
Amount due   {items|sumProduct:qty:unit_price:vat_factor|currency:EUR}
```

With the sample data that is €26,854.00 net, €5,639.34 VAT at 21%, €32,493.34
due. Change a quantity in `invoice.data.json` and all three move.

Each line item therefore carries `vat_rate` (0.21) and `vat_factor` (1.21).
`vat_factor` is `1 + vat_rate`: the formatter pipeline can multiply a running
total by a field, but it cannot add the output of one pipeline to another, so
the gross total is expressed as a third `sumProduct` rather than as
`subtotal + VAT`. `verify.js` asserts `vat_factor == 1 + vat_rate` and that the
per-line `vat_rate` equals the invoice-level one, so the two cannot drift.

Also in there:

- `{%logo}` in the letterhead, filled from a base64 PNG in the data.
- `{$index1}` for the line numbers, `{items|count}` for "6 line items".
- A row loop: `{#items}` sits in the first cell of the line row and `{/items}`
  in the last, so the whole `<w:tr>` repeats. The totals rows live in the same
  table, after the loop, which is why the "Amount due" figure lines up exactly
  with the Amount column.
- The status banner is a block-level section: `{#paid}` and `{/paid}` each sit in
  a paragraph of their own around a shaded table, so the branch that does not
  fire leaves no empty coloured bar behind. Set `"paid": true` in the data and
  the red OVERDUE banner is replaced by a green PAID IN FULL one — `verify.js`
  renders both and asserts each contains only its own branch.
- `{customer.address}` is a single string with newlines in it; those become line
  breaks inside the paragraph rather than separate paragraphs.
- The header carries `Invoice {invoice_no}` and the footer carries it again next
  to `Page N of M`.

## 2. sales-report.xlsx

A monthly sales workbook: a title block, twelve data rows generated from one
template row, a total row, three key figures, and a summary sheet.

What makes it a spreadsheet rather than a table of strings:

- `{units}`, `{revenue}` and `{prior_revenue}` are alone in their cells, so they
  are written as real numbers and keep the cell's number format — `#,##0` for
  units, `[$€-1809]#,##0.00` for money.
- The total row is `=SUM(E6:E6)` in the template. After the loop expands it is
  `=SUM(E6:E17)`, and LibreOffice evaluates it to €542,778.00, which is the sum
  of the twelve revenues.
- The growth column is `=IF(F6=0,"",E6/F6-1)` — a per-row formula that follows
  its own copy — formatted as a percentage, with negative values turned red by a
  conditional format. Row banding is another conditional format, `MOD(ROW(),2)=0`,
  so it keeps alternating however many rows the data produces.
- The share column is `=E6/E7`, pointing at the total row below the loop; after
  expansion every copy points at the total row's new position, and the column
  sums to 100.0%.
- `=INDEX(B6:B6,MATCH(MAX(E6:E6),E6:E6,0))` names the best-performing rep. With
  this data it returns "Lukas Brandt", which is the rep on the largest single
  row.
- The `Summary` sheet loops `{#regions}`, and its last row is
  `=IF(D6='Monthly sales'!E7,"Yes","No")` — a cross-sheet reference that has to
  survive row expansion on both sheets. It renders "Yes".
- Rows 1–5 are frozen on the detail sheet and rows 1–4 on the summary.

The two arrays in the data are consistent by construction: `regions` is the
roll-up of `rows`, and `verify.js` re-derives it and compares.

## 3. quarterly-deck.pptx

A nine-slide business review: title, group scorecard, six regional slides, and a
priorities slide.

- The scorecard table repeats one `<a:tr>` per region and closes with a total row
  using `{regions|sum:revenue|currency:EUR}`, `{regions|count}` and
  `{regions|sum:units|number}` — €1,618,440.00 across 44,460 units.
- Slide 3 in the template is a slide loop. `{#regions}` and `{/regions}` each sit
  alone in a small text box; those boxes are removed and the slide is cloned once
  per region. Six regions in, nine slides out — `verify.js` asserts the PDF has
  exactly that many pages.
- Inside the loop, `{name}`, `{revenue|currency:EUR}`, `{growth|percent:1}` and
  `{units|number}` come from the region, while `{../company}`, `{../deck_period}`
  and `{../group_growth|percent:1}` reach one scope outwards. Writing them as
  `../` rather than relying on the fallback keeps the render warning-free.
- `{$index1}` and `{$length}` produce the "Region 3 of 6" footer.
- Each cloned slide gets its own notes slide, with the region's own talking
  points and its own question for the room.

The deck's `logo` entry carries both `width` and `height`. The PPTX renderer does
not derive the missing dimension from the image's own aspect ratio the way the
DOCX renderer does, so a logo given only a width comes out stretched; giving both
avoids it.

## Rendering them through the API

Both commands below were run against a local server (`node src/server.js`) with a
freshly created account. Set `DOCMINT_URL` to your instance and `DOCMINT_KEY` to
your key.

Send the template with the request:

```sh
jq -n \
  --arg t "$(base64 -w0 examples/invoice.docx)" \
  --slurpfile d examples/invoice.data.json \
  '{template_base64:$t, data:$d[0], output:"document",
    locale:"en-GB", currency:"EUR", filename:"invoice-{invoice_no}.docx"}' \
| curl -sS -X POST "$DOCMINT_URL/v1/render" \
    -H "Authorization: Bearer $DOCMINT_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @- --output invoice.docx
```

The response comes back as `invoice-MFS-2026-0417.docx` — `filename` is itself a
template, filled from the same data.

`output` may be `"document"` (the Office file, the default), `"pdf"` or
`"both"`; the PDF step needs the LibreOffice-enabled deployment, so a bare
`node src/server.js` on a machine without LibreOffice reports
`pdf_available: false` at startup and only `"document"` works there.

Or upload the template once and render it by name — which is also how you find
out what fields it needs before you send any data:

```sh
jq -n --arg f "$(base64 -w0 examples/invoice.docx)" \
  '{name:"invoice", file_base64:$f, description:"Commercial invoice example"}' \
| curl -sS -X POST "$DOCMINT_URL/v1/templates" \
    -H "Authorization: Bearer $DOCMINT_KEY" \
    -H 'Content-Type: application/json' --data-binary @-

curl -sS "$DOCMINT_URL/v1/templates/invoice/fields" \
  -H "Authorization: Bearer $DOCMINT_KEY"
```

The upload answers `{"name":"invoice","format":"docx","version":1, ...}` and the
fields call lists all 35 fields this template needs, each with its type, whether
it repeats, and where in the file it is used — for example `company.name`,
`"used": 4`, at `word/document.xml, table 1 row 1, paragraph 2` and
`word/header1.xml, paragraph 1`.

The same two commands work for `sales-report.xlsx` and `quarterly-deck.pptx`;
change the file name and the data file.

## Two things LibreOffice would not carry across

Both are done by short, commented scripts in `src/`, called from `build.sh`,
because the alternative is a template that quietly lacks a feature:

- `src/freeze-panes.js` — LibreOffice drops the `<office:settings>` view block
  when it reads a flat-ODF spreadsheet (converting `sales-report.fods` to `.ods`
  produces a `settings.xml` with no `Views` item-set at all), so the frozen pane
  cannot be authored in the source. The script writes the `<pane>` element into
  the built workbook. DocMint never rewrites the part of a worksheet above
  `<sheetData>`, so it survives the fill; `verify.js` checks that it does.
- `src/style-deck-table.js` — Impress discards `style:family="table-cell"` styles
  from flat ODF and stamps every cell with its own default table blue. The script
  writes the intended `<a:tcPr>` into the template's three rows; the renderer
  clones whole rows, so every generated row inherits it.

One more thing worth knowing if you edit the sources: Impress also ignores the
flat-ODF page size and always imports its 28 × 15.75 cm 16:9 canvas, so the deck
is laid out for that rather than for PowerPoint's 33.87 × 19.05 cm.
