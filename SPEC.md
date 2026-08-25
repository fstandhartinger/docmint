# DocMint template language and renderer contract

This is the contract. `src/template/{scan,resolve,formatters,errors}.js` implement it
and are already written and tested. Format renderers (`docx.js`, `xlsx.js`, `pptx.js`)
consume them and must not re-invent any of it.

## Why our own engine rather than docxtemplater

docxtemplater's free MIT core covers DOCX **and PPTX** — including loops, inverted
sections and table-row expansion; that was verified from the published tarball's
`js/file-type-config.js`, which exports exactly `{docx, pptx}`. What it does not
cover is XLSX, which is hard-coded to throw `xlsx_filetype_needs_xlsx_module` and
is a 500 EUR/year product, as are images, HTML-into-DOCX, slide cloning and
knowing where a tag failed.

So building on it would have meant a product whose spreadsheet support is
permanently absent or permanently rented. Writing the OOXML surgery ourselves
gives one syntax across all three formats, images included, no paid ladder ever,
and full control over the behaviour this product is judged on: failing loudly on
an unresolved placeholder, by name and by location.

(An earlier version of this file said the free core "covers DOCX only". That was
wrong, and it contradicted DECISIONS.md, which had it right. Corrected.)

## Syntax

Both delimiter styles work, always, in every format:

    {name}        {{name}}

| Form | Meaning |
|---|---|
| `{name}` | value |
| `{user.email}`, `{items.0.sku}` | dotted path, numeric index |
| `{#items} … {/items}` | section: once per array element; once for an object; once for a truthy scalar; never for an empty array or a falsy value |
| `{^items} … {/items}` | inverted section: renders only when the value is absent, empty or falsy |
| `{/}` | closes the innermost open section |
| `{.}` | the current scope itself, for arrays of scalars |
| `{../x}` | one scope outwards |
| `{$index}` `{$index1}` `{$first}` `{$last}` `{$length}` | loop metadata |
| `{%logo}` | image (DOCX, PPTX, XLSX) |
| `{@rawXml}` | raw OOXML, unescaped |
| `{!note}` | comment, removed from the output |
| `{price\|currency:EUR}` | formatter pipeline |

Inside a section the outer scopes stay visible, so `{currency}` from the invoice
root resolves inside `{#items}` without `../`.

Anything between braces that does not parse as a tag is left as literal text, so a
document containing `{ "total": 12 }` or `.a { color: red }` renders unchanged.

## Formatters

The authoritative list is `GET /v1/capabilities`, which reads it out of
`src/template/formatters.js` so it cannot be documented into existence. At the
time of writing there are 28:

**Text** `upper lower title trim`
**Numbers** `number currency percent round ordinal multiply add subtract divide`
**Dates** `date`
**Absence** `default`
**Lists, reducing** `join sum sumProduct count`
**Lists, shaping** `filter reject sort reverse limit skip unique groupBy`
**Conditions** `yesno`

`{items|sum:amount}` and `{items|sumProduct:qty:price}` are the ones that matter:
a total in a template must be computed from the data, never typed in.

The list-shaping formatters work on a section too, so
`{#items|filter:active|sort:due_date}` sorts and filters in the template rather
than requiring the caller to do it before the data ever arrives.

A formatter that returns a NUMBER (`sum`, `sumProduct`, `round`, `count`, the
arithmetic ones) lands in a spreadsheet as a real numeric cell, so `SUM()` over
the column works. One that returns formatted TEXT (`currency`, `number`,
`percent`, `date`) lands as text, because the caller asked for a specific
rendering. In a spreadsheet, prefer a bare `{total}` plus the cell's own number
format.

## The missing-field contract — the thing this product is judged on

| Situation | Behaviour |
|---|---|
| key absent from the data | **HTTP 422, naming the field, the location in the document, the visible field names, and a "did you mean"** |
| key present, value `null` | renders as empty — the caller explicitly said "nothing here" |
| `{x\|default:—}` | the sanctioned opt-out |
| `onMissing: "empty"` | opt-in relaxation, off by default — **and every field it blanks is reported as a `field_blanked` warning**, naming the field and the place, so it cannot quietly become the silent-blank failure it is meant to replace |
| `onMissing: "keep"` | leaves the tag visible; for template debugging only, and likewise reported |

A rendered document must **never** contain the text `undefined` or an unresolved
`{{tag}}` that the caller did not explicitly ask to keep.

Two things can still produce a document that is clean but not what was intended,
and neither is an error, so both are reported on the `warnings` channel of the
render response rather than being suppressed:

| Warning | When |
|---|---|
| `section_rendered_empty` | a loop rendered nothing because its list was empty. The most likely real-world data fault — the upstream query returned nothing — and it produces a perfectly sendable invoice with a zero total. |
| `resolved_from_outer_scope` | a tag inside a loop resolved from an enclosing scope, so it prints the same value on every row. Sometimes intended (`{currency}` from the invoice root), sometimes the bug docxtemplater's own documentation presents as normal behaviour. `strictScope: true` turns it into an error. |
| `field_blanked` / `field_left_as_tag` | `onMissing` was relaxed and this field was affected. |
| `macros_not_preserved` | a macro-enabled template was filled. |

The render response carries `warnings`, and the binary response carries the count
in `X-DocMint-Warnings`.

## Renderer contract

Each format renderer exports:

```js
async function render(buffer, data, opts) -> {
  buffer,            // the filled file
  stats: {
    tags: number,          // tags found
    resolved: number,
    sections: number,
    images: number,
    parts: string[],       // which zip parts were touched
  }
}
async function inspect(buffer) -> {
  format, parts, tags: [{ expr, kind, location }],  // for GET /v1/templates/:id/fields
  fields: string[],        // distinct data paths the template needs
}
```

`opts` = `{ locale, currency, timezone, onMissing, images }`.

Errors are `TemplateError` from `src/template/errors.js`, with `field` and
`location` set — including errors raised inside a formatter, which do not know
where they are and have the tag and location attached to them on the way out.
`location` must be human-usable: `"word/document.xml, paragraph 12"`,
`"Sheet1!C7"`, `"slide 3, shape \"Title\""`.

`unknown_formatter` is the one error whose subject is not a data path; it carries
the offending name in `formatter` and leaves `field` null, because `field` means
"a path into your data" everywhere else and overloading it would make the error
unreadable by machine.

"Did you mean" works on any segment of a dotted path, not only the last one:
with data `{"custmer": {"name": …}}` and a template writing `{customer.name}`, the
hint names `custmer.name`. Comparing only the leaf segment — which is the obvious
implementation — misses exactly the case that occurs most.

## The hard part: OOXML splits text runs

Word will store `{{name}}` as

```xml
<w:r><w:t>{{na</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>me}}</w:t></w:r>
```

because the author edited the middle of the word, or spellcheck ran, or the file
came back from Google Docs. Any renderer that scans run-by-run will miss every
real-world template. The mandatory approach:

1. Collect the runs of one paragraph (`w:p` / `a:p`) in document order.
2. Concatenate their `w:t` / `a:t` text into one string, remembering the offset
   range each run contributed.
3. Scan that string for tags.
4. Write results back by slicing the runs: a tag's replacement text goes entirely
   into the run that held the tag's **first** character, so it inherits that run's
   formatting; the remaining runs of the tag get the covered characters removed.

**This is the single most important correctness property in the codebase.** A test
that only uses templates written by the renderer's own test helper will not catch a
regression here. Every renderer needs a test with deliberately split runs.

## Zip handling

Node has zlib built in — `zlib.inflateRawSync` / `deflateRawSync`. We ship our own
minimal zip reader/writer in `src/ooxml/zip.js` (no JSZip, no PizZip) so the API has
as few dependencies as the node does. It must:

- preserve entry order and the STORED-vs-DEFLATED method of untouched entries
  byte-for-byte (Word is tolerant, but Excel is not, about `[Content_Types].xml`);
- support Zip64 read for large templates;
- never rewrite an entry we did not change.
