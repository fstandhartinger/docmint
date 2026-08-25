# DocMint template language and renderer contract

This is the contract. `src/template/{scan,resolve,formatters,errors}.js` implement it
and are already written and tested. Format renderers (`docx.js`, `xlsx.js`, `pptx.js`)
consume them and must not re-invent any of it.

## Why our own engine rather than docxtemplater

docxtemplater's MIT core covers DOCX only; its XLSX module, PPTX support, image
module and HTML module are separately-licensed paid products. Building on it would
mean either paying per-feature forever or shipping a product whose spreadsheet and
slide support is permanently absent. Writing the OOXML surgery ourselves gives one
syntax across all three formats, no per-feature licence, and full control over the
one behaviour we care most about: failing loudly on an unresolved placeholder.

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

`upper lower title trim number currency percent round date default join sum
sumProduct count multiply add subtract divide ordinal yesno`

`{items|sum:amount}` and `{items|sumProduct:qty:price}` are the ones that matter:
a total in a template must be computed from the data, never typed in.

## The missing-field contract — the thing this product is judged on

| Situation | Behaviour |
|---|---|
| key absent from the data | **HTTP 422, naming the field, the location in the document, the visible field names, and a "did you mean"** |
| key present, value `null` | renders as empty — the caller explicitly said "nothing here" |
| `{x\|default:—}` | the sanctioned opt-out |
| `onMissing: "empty"` | opt-in relaxation, off by default |
| `onMissing: "keep"` | leaves the tag visible; for template debugging only |

A rendered document must **never** contain the text `undefined`, an unresolved
`{{tag}}`, or a silently blank cell where a number was meant to be.

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
`location` set. `location` must be human-usable: `"word/document.xml, paragraph 12"`,
`"Sheet1!C7"`, `"slide 3, shape \"Title\""`.

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
