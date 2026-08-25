# Decisions, and the evidence behind them

Anything asserted on the landing page, in the docs or in the node's description has
to be traceable to a line in this file, and every line here has to be traceable to
something someone actually fetched or ran.

## Honesty constraints on comparative copy

**APITemplate.io is NOT a competitor for Office document generation. Never compare
against it on Word/Excel/PowerPoint features.** Verified 2026-08-25 against their
live v2 OpenAPI spec (`apitemplateiov2_api.yaml`, Last-Modified 2026-05-18): zero
occurrences of "docx"; the complete endpoint list is create-pdf, create-image,
create-pdf-from-html, create-pdf-from-url, create-pdf-from-markdown,
list/get/update-template, merge-pdfs, list-objects, delete-object,
account-information. `output_format` is documented as "pdf (default), html, png, or
jpeg". Live probes of `/v2/create-pdf-from-docx-template`, `/v2/create-pdf-from-docx`
and `/v2/create-docx` all return 404 "API not found", while `/v2/create-pdf` returns
400 invalid-key, i.e. it exists. Wayback CDX shows no Word/DOCX page has ever
existed on the domain. They cannot accept a .docx even as input.

The valid Office comparators are **Carbone**, **Docupilot** and **Formstack
Documents**. APITemplate.io is a comparator for HTML-to-PDF only, which is
PDFMint's market, not this one.

## Licence audit — the result, with the clause that decided each

Full audit run 2026-08-25 from primary sources (npm tarball LICENSE files, GitHub
LICENSE, vendor licensing pages).

| Dependency | Licence | Verdict |
|---|---|---|
| **carbone / Carbone CE** | Custom "Carbone Community License Agreement" | **REJECTED — used nowhere.** |
| LibreOffice (`soffice`, exec'd as a separate process) | MPL-2.0 (+LGPL-3.0-or-later dual) | **Used.** Safe. |
| Everything else in `src/` | none — the fill engine is ours | n/a |

Carbone's §2.2 Prohibitions, verbatim:

> "Notwithstanding any other provision in this CCL Agreement, You are prohibited
> from (i) using any Carbone Community Edition Software to provide
> document-generator-as-a-service services, or to provide any form of
> software-as-a-service or service offering in which the Carbone Community Edition
> Software is offered or made available to third parties to provide Document
> Generator functions or operations, other than as part of Your Value Added
> Products or Services…"

and its only escape hatch, §3.9, requires that the value-added product "are not
primarily Document Generator products or services". DocMint is primarily a
document generator, so it fails the carve-out. §2.1(a) additionally forbids
exposing the feature "directly or indirectly (e.g., via a wrapper)". **Carbone is
not installed, not vendored, and not in any Dockerfile.**

LibreOffice is safe here for four independent reasons, any one sufficient: MPL-2.0
obligations all trigger on *distribution* and we distribute nothing; MPL is
file-level copyleft and our files are not Covered Software; §3.3 explicitly permits
a "Larger Work" under terms of our choice; and we `exec` an unmodified distro
binary as a separate process rather than linking. Conditions we honour: we do not
patch LibreOffice source, we do not strip its notices, and we do not use the
LibreOffice name or logo in marketing. If the Docker image is ever shipped to a
customer, §3.2(a) then requires pointing them at
https://www.libreoffice.org/download/download/?type=src — noted for that day.

Office Open XML itself carries no patent risk: Microsoft's Open Specification
Promise covers Ecma-376, ISO/IEC 29500:2008/2012/2016 and [MS-DOCX], [MS-XLSX],
[MS-PPTX] by name. Trademark discipline: say "Microsoft Word (.docx) files", never
"Microsoft Word Generator", never a Microsoft logo, never any implied endorsement.

## Why our own fill engine rather than docxtemplater

docxtemplater's free MIT core genuinely covers DOCX and PPTX including loops,
inverted sections and table-row expansion — that was verified from the tarball's
`js/file-type-config.js`, which exports exactly `{docx, pptx}`. But its XLSX
support is a paid module, hard-coded to throw
`xlsx_filetype_needs_xlsx_module`, and images are a separate 500 EUR/year module.
Building on it would mean a product whose spreadsheet support is permanently
absent and whose image support is rented. Writing the OOXML surgery ourselves
gives one syntax across all three formats, images included, no paid ladder ever,
and full control over the behaviour this product is judged on: failing loudly and
by name on an unresolved placeholder.

## Measured numbers (re-measure before changing any of these in copy)

| What | Measured | How |
|---|---|---|
| LibreOffice added image size | +714 MB (200 MB base -> 914 MB) | `docker images` on the probe image |
| PDF conversion, cold profile | 1.25 s wall, 219 MB peak RSS | `/usr/bin/time -v` in a 512 MB container |
| PDF conversion, warm profile | 1.02 s wall, 219 MB peak RSS | same, 5 runs |

219 MB peak is why `MAX_CONCURRENT_PDF` defaults to 1 on a 512 MB instance: two at
once is an OOM kill, which reaches the user as a dropped connection with no error
at all.

## Pricing

Docupilot charges **$29/month for 100 documents — $0.29 per document.** Carbone
Cloud runs $29 to $595/month. Office document generation clearly sustains far
higher per-document prices than HTML-to-PDF (APITemplate.io's floor is ~$0.006/PDF).

DocMint: Free 30/month, Starter $9/2,000, Pro $29/20,000, Scale $99/100,000.
At Pro that is $0.00145 per document. The comparison that may be published is
against Docupilot's own published $29/100, because both numbers are on their
pricing page and ours is in `src/config.js`.

## The wedge: nobody tells you what fields the template needs

Verified across all four products on 2026-08-25. Every one of them joins the data
payload to the template by invisible string matching, and none of them will tell
you the names before you render.

- Every existing n8n node in this space ships the same control: a raw JSON
  textarea. The official `n8n-nodes-carbone@2.0.0` has
  `{displayName:'Data', name:'data', type:'json', default:'{}'}`.
  `n8n-nodes-docxtemplater` has the same. `n8n-nodes-fill-docx` is worse — a plain
  string the user must `JSON.stringify` themselves.
- The tag names live inside a zipped binary that a workflow cannot open.
- **Carbone's API has no template-introspection endpoint.** `GET /templates/tags`
  returns organisational folder labels, not placeholders.
- A typo in `{d.custmer.name}` does not error in Carbone; it renders blank.
- docxtemplater sells finding out where a tag failed as a **500 EUR/year paid
  module** (`error-location`, which inserts Word comments at the failures).
- Formstack's management API does return `"fields":[{"key":…,"name":…}]` on
  template create — proving the demand — but it is not surfaced in any
  automation UI.

So the loop every user is in today is: guess the keys, render, open the DOCX in
Word, find the silently-empty field, guess again.

**Therefore:** `GET /v1/templates/:name/fields` is a first-class endpoint, and the
n8n node uses n8n's `resourceMapper` to turn those fields into real, typed,
expression-capable inputs instead of a JSON blob. Combined with failing loudly on
an unresolved placeholder, this removes the guess-render-inspect cycle entirely.

## Competitor billing models, quoted, for the honest comparison table

- **Carbone bills by payload size, not per document**: "(JSON bytes + image bytes +
  PDF bytes) / 1,000,000 = documents consumed." A 2.3 MB render costs 3 documents.
  Essential EUR29/mo = 1,000 documents (EUR0.029); Advanced EUR159/mo = 20,000
  (EUR0.008); Advanced Ultra EUR595/mo = 500,000.
- **Docupilot bills per DELIVERY, not per document**: "if you generate an invoice
  and send it via email to recipients while also uploading it to Google Drive, it
  will use 2 credits", and "Downloading generated document also consumes 1 credit."
  Starter $29/mo = 100 ($0.29/doc nominal, ~$0.58 in a two-delivery flow).
  It also hard-stops: "You will not be able to generate documents once you have hit
  100% limit."
- **Formstack Documents** meters deliveries too; the only public plan is the Suite
  at $250/mo annual for 250 deliveries ($1.00+/doc).
- **DocMint bills once per document produced.** A PDF costs one extra credit than
  the Office file because it costs us about a hundred times the CPU; nothing else
  is metered, and downloading a file you already generated is free.

## What the existing n8n nodes cannot do, and why

Confirmed by unpacking each tarball. Verbatim `dependencies`:

    n8n-nodes-carbonejs@1.3.0       { "carbone": "^3.5.5", "pdf-lib": "^1.17.1" }
    n8n-nodes-docxtemplater@1.0.1   { "docxtemplater": "^3.60.1", "pizzip": "^3.1.8",
                                      "jexl": "^2.3.0", "vm2": "^3.9.19", ... }
    n8n-nodes-fill-docx@0.2.2       { "easy-template-x": "^6.2.0" }
    n8n-nodes-excel-templater@1.0.5 { "exceljs": "^4.3.0" }

n8n's rule: "Specifically, verified community nodes aren't allowed to use any
run-time dependencies." All four are therefore permanently ineligible for
verification and for the in-app nodes panel. The only zero-dependency node in the
space is the official `n8n-nodes-carbone`, which is a thin client to a paid API —
the same shape as ours. That is the structural trade: runtime dependencies or a
SaaS bill, pick one.

Individually, and worth knowing because these are the things users complain about:
- `n8n-nodes-carbonejs` cannot make PDFs in Docker. Its own README: "This
  operation requires LibreOffice to be installed... If using the Docker images,
  this operation doesn't seem to work :(". It also needs a Merge node in
  Combine/Multiplex mode just to get the binary and the JSON onto one item, and it
  overwrites the item's JSON with the render context. And using it as a service at
  all breaches the Carbone CCL.
- `n8n-nodes-docxtemplater` has no PDF output at all, replaces docxtemplater's
  standard parser with JEXL so the syntax is not the one users know, ships three
  built-in transforms, and carries `vm2` — a discontinued sandbox with published
  escape CVEs — in a node that executes user-supplied expressions.
- `n8n-nodes-excel-templater` is not a template filler: it writes values into
  hard-coded cell addresses via absolute filesystem paths, so it cannot take
  binary in or out and cannot run on n8n Cloud at all.

## Template syntax choice, and why

Docupilot uses Handlebars (`{{ }}`). docxtemplater and Carbone use single braces
(`{name}`, `{d.name}`). APITemplate.io uses Jinja2. Picking one strands the others.

DocMint accepts **both `{name}` and `{{name}}`**, in every format, always. It costs
one branch in the scanner and it means a template written for docxtemplater and a
template written for Docupilot both work unchanged. Bracket-quoted keys
(`{{[Customer Name]}}`) are supported for the same reason: it is the Docupilot form
for a field name containing spaces.

We deliberately did NOT invent a third syntax. Where we add something the others do
not have — the formatter pipeline, and formatters on a section
(`{#items|filter:active|sort:due}`) — it is additive: a template that does not use
it renders identically.

## Where the competition is genuinely ahead, stated plainly

Not everything is in our favour and the docs must not pretend otherwise.

- **Carbone's formatter library is larger than ours** and includes aggregates
  (`aggSum`, `cumSum`), an i18n system, currency conversion with live rates, and
  `drop`/`keep` block operators. Ours covers the common cases; theirs covers more.
- **Carbone offers converter choice** (LibreOffice / OnlyOffice / Chromium / their
  own ICE engine, which they claim is "60x faster than LibreOffice on a 1000-page
  document"), PDF/A, watermarking and PDF encryption. We have LibreOffice only.
- **Docupilot has richtext (HTML and Markdown into DOCX), QR codes, maps and
  dynamic PDF passwords.** We have none of those yet.
- **Docupilot and Carbone both offer delivery integrations** (email, Drive, S3).
  We return the file and let n8n do the delivering — which is the right split for
  a workflow tool, but it is a difference, not a strict advantage.

## Rendering stack — the final answer, and what it costs

**DocMint uses no third-party document library at all.** The fill engine is
`src/ooxml/{zip,xml,runs}.js` and `src/template/{scan,resolve,formatters,errors}.js`
plus one renderer per format, all written for this project. The only external
program is LibreOffice, exec'd as a separate process for the optional PDF step.

**Paid modules relied on: none. Licence cost: 0 EUR/year, now and permanently.**

That matters because the obvious build — docxtemplater — would have cost:

| Feature | docxtemplater | DocMint |
|---|---|---|
| DOCX fill, loops, conditionals | free (MIT core) | ours |
| PPTX fill, loops, table rows | free (MIT core) | ours |
| **XLSX fill** | **500 EUR/yr module** | ours |
| **Images into documents** | **500 EUR/yr module** | ours |
| Slide cloning in PPTX | 500 EUR/yr module | ours |
| Charts, styling, footnotes, subtemplates | 500 EUR/yr each | not implemented |
| HTML into DOCX | 500 EUR/yr module | **not implemented** |
| Built-in formatters | **zero** — every one is code you write | 27 built in |
| Where a tag failed | 500 EUR/yr `error-location` module | built in, on every error |
| All 18 modules | 3,000 EUR/yr | n/a |

The homepage claim "Generate docx, pptx, xlsx or odt" is qualified further down:
"The open-source core supports only DOCX and PPTX; for XLSX support, you need the
XLSX Module." Building on it meant either a permanently crippled spreadsheet path
or a recurring licence bill on a product whose whole margin story is that a
document costs us a tenth of a cent.

Writing the OOXML surgery ourselves also avoids two behaviours of the incumbent
that are precisely the failure this product is positioned against:

1. **`nullGetter` renders the literal string "undefined" into the document** by
   default. DocMint refuses to render at all and names the field.
2. **A tag inside a loop silently falls back to an outer scope.** Their own docs
   present `{#products}{name}{/products}`, where `name` exists only at the root,
   as normal behaviour: every row prints the same value and nothing errors.
   DocMint allows it (because `{currency}` from the invoice root is a reasonable
   thing to write) but **reports every occurrence back in the render response** as
   a `resolved_from_outer_scope` warning naming the field, the location and the
   fields the loop item actually has — and `strictScope: true` turns it into an
   error. Neither behaviour exists in any competitor.

We also do not inherit docxtemplater's `paragraphLoop` trap (off by default,
silently misbehaves on leading whitespace, two loops on a line, or Shift+Enter
breaks) or its `vm2`/`angular-expressions` dependency chain, because there is no
expression evaluator: formatters are a fixed, audited list, so no user-supplied
string is ever compiled or executed.
