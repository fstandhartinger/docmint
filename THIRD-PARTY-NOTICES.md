# Third-party notices

DocMint. Last checked against the tree on 25 August 2026.

## The document fill engine has no third-party dependencies

The part of DocMint that reads a `.docx`, `.xlsx` or `.pptx`, finds the
placeholders, resolves them against your data and writes the file back is written
for this project. It is `src/ooxml/{zip,xml,runs}.js`,
`src/template/{scan,resolve,formatters,errors}.js` and one renderer per format.

There is **no docxtemplater, no Carbone, no easy-template-x, no exceljs, no JSZip
and no PizZip** in this codebase — not installed, not vendored, not in the
Dockerfile. Zip handling uses Node's built-in `zlib`. There is no expression
evaluator, so nothing like `vm2` or `angular-expressions` is present either;
formatters are a fixed, audited list and no user-supplied string is ever compiled
or executed.

Paid modules relied on: **none**. Third-party licence cost: **0 EUR/year**.

Carbone Community Edition was evaluated and **rejected**. Its Carbone Community
License Agreement, §2.2, prohibits "using any Carbone Community Edition Software
to provide document-generator-as-a-service services", and the §3.9 carve-out
requires that the value-added product "are not primarily Document Generator
products or services". DocMint is primarily a document generator, so it fails the
carve-out. It is used nowhere.

## npm dependencies of the service

From `package.json`. Licence taken from each package's own `package.json` in
`node_modules`.

| Package | Version | Licence | Used for |
|---|---|---|---|
| [express](https://www.npmjs.com/package/express) | 4.22.2 | MIT | HTTP server and routing |
| [pg](https://www.npmjs.com/package/pg) | 8.23.0 | MIT | PostgreSQL client |
| [bcryptjs](https://www.npmjs.com/package/bcryptjs) | 3.0.3 | BSD-3-Clause | Password hashing |
| [stripe](https://www.npmjs.com/package/stripe) | 17.7.0 | MIT | Subscription billing |

### Transitive dependencies

80 further packages are installed as dependencies of the four above. Every one of
them is under a permissive licence:

| Licence | Count | Packages |
|---|---:|---|
| MIT | 75 | accepts, array-flatten, body-parser, bytes, call-bind-apply-helpers, call-bound, content-disposition, content-type, cookie, cookie-signature, debug, depd, destroy, dunder-proto, ee-first, encodeurl, es-define-property, es-errors, es-object-atoms, escape-html, etag, finalhandler, forwarded, fresh, function-bind, get-intrinsic, get-proto, gopd, has-symbols, hasown, http-errors, iconv-lite, ipaddr.js, math-intrinsics, media-typer, merge-descriptors, methods, mime, mime-db, mime-types, ms, negotiator, object-inspect, on-finished, parseurl, path-to-regexp, pg-cloudflare, pg-connection-string, pg-pool, pg-protocol, pg-types, pgpass, postgres-array, postgres-bytea, postgres-date, postgres-interval, proxy-addr, range-parser, raw-body, safe-buffer, safer-buffer, send, serve-static, side-channel, side-channel-list, side-channel-map, side-channel-weakmap, statuses, toidentifier, type-is, undici-types, unpipe, utils-merge, vary, xtend |
| ISC | 4 | inherits, pg-int8, setprototypeof, split2 |
| BSD-3-Clause | 1 | qs |

No copyleft licence appears anywhere in the tree. Reproduce the audit with:

```sh
node -e "const fs=require('fs');for(const d of fs.readdirSync('node_modules').sort()){\
if(d[0]==='.')continue;const p='node_modules/'+d+'/package.json';\
if(!fs.existsSync(p))continue;const j=JSON.parse(fs.readFileSync(p));\
console.log(d,j.version,j.license);}"
```

## LibreOffice — a separate process, not a library

The optional PDF step (`output: "pdf"` or `output: "both"`) runs **LibreOffice**
headless. It is executed as a separate process — `soffice --headless
--convert-to pdf` — from `src/pdf.js`. It is not linked into DocMint and no
LibreOffice code is compiled into anything here.

| | |
|---|---|
| **Component** | LibreOffice (`libreoffice-writer`, `libreoffice-calc`, `libreoffice-impress`, unmodified Debian packages) |
| **Licence** | **Mozilla Public License 2.0**, with parts additionally available under LGPL-3.0-or-later |
| **Licence text** | <https://www.mozilla.org/en-US/MPL/2.0/> |
| **Source code** | <https://www.libreoffice.org/download/download/?type=src> |
| **Project** | <https://www.libreoffice.org/> |

DocMint does not modify LibreOffice source, does not strip its notices, and does
not use the LibreOffice name or logo in its marketing. The MPL's obligations
attach to *distribution*; DocMint operates the software as a hosted service and
distributes nothing. If the Docker image is ever handed to a customer, MPL-2.0
§3.2(a) then requires pointing them at the source URL above — which is why it is
recorded here.

LibreOffice depends on a Java runtime for some filters, so the image also
installs **OpenJDK JRE (headless)** as packaged by Debian, under the **GNU
General Public License v2 with the Classpath Exception**. It, too, is only ever
executed as a separate process.

## Fonts in the container image

Fonts are installed so that a template written in Calibri or Cambria converts to
PDF with the right metrics instead of a fallback face that shifts every table
column. They are unmodified Debian packages, embedded into generated PDFs by
LibreOffice in the normal way.

| Package | Upstream | Licence as declared by the Debian package |
|---|---|---|
| `fonts-crosextra-carlito` | Carlito (metric-compatible with Calibri) | SIL Open Font License 1.1 |
| `fonts-crosextra-caladea` | Caladea (metric-compatible with Cambria) | SIL Open Font License 1.1 |
| `fonts-liberation2` | Liberation Fonts 2 | SIL Open Font License 1.1 |
| `fonts-dejavu-core` | DejaVu | Bitstream Vera Fonts Licence, plus public-domain additions |
| `fonts-noto-core`, `fonts-noto-cjk`, `fonts-noto-color-emoji` | Google Noto | SIL Open Font License 1.1 |

The authoritative licence text for each ships inside the image at
`/usr/share/doc/<package>/copyright`.

## File formats

DocMint reads and writes Office Open XML: Ecma-376 / ISO/IEC 29500, and the
`[MS-DOCX]`, `[MS-XLSX]` and `[MS-PPTX]` documents. These are covered by
Microsoft's Open Specification Promise.

Microsoft, Microsoft Word, Microsoft Excel and Microsoft PowerPoint are
trademarks of Microsoft Corporation. DocMint is not affiliated with, endorsed by
or sponsored by Microsoft.

## The website

The pages under `public/` load nothing from any third-party host: no fonts, no
CDN, no analytics, no tracking pixel. Type is set in the reader's own system font
stack.
