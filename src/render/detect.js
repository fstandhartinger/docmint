'use strict';

const { readZip, readText } = require('../ooxml/zip');
const { ApiError } = require('../errors');

/**
 * What kind of file is this, really?
 *
 * Not by extension and not by the Content-Type the client claimed — both are
 * routinely wrong, and the failure they cause is a stack trace deep inside a zip
 * parser rather than a sentence the user can act on. The main part's content type
 * in `[Content_Types].xml` is the authoritative answer, and it also lets us
 * recognise the near misses (the old binary .doc, an OpenDocument .odt, a PDF
 * someone uploaded by mistake) and say so by name.
 */

const MAIN_TYPES = [
  ['docx', 'wordprocessingml.document.main+xml'],
  ['docx', 'wordprocessingml.template.main+xml'],       // .dotx
  ['xlsx', 'spreadsheetml.sheet.main+xml'],
  ['xlsx', 'spreadsheetml.template.main+xml'],          // .xltx
  ['pptx', 'presentationml.presentation.main+xml'],
  ['pptx', 'presentationml.template.main+xml'],         // .potx
  ['pptx', 'presentationml.slideshow.main+xml'],        // .ppsx
];

/** Macro-enabled variants. We fill them, but the macros do not survive our rewrite intact. */
const MACRO_TYPES = [
  ['docx', 'wordprocessingml.document.macroEnabled', '.docm'],
  ['xlsx', 'spreadsheetml.sheet.macroEnabled', '.xlsm'],
  ['pptx', 'presentationml.presentation.macroEnabled', '.pptm'],
];

function detect(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, 'empty_template', 'The template file is empty.', { docs: '/docs#templates' });
  }

  const sig = buffer.subarray(0, 8);

  if (sig.subarray(0, 4).toString('latin1') === '%PDF') {
    throw new ApiError(415, 'template_is_pdf',
      'That is a PDF, and a PDF cannot be used as a template here.', {
        hint: 'DocMint fills Word, Excel and PowerPoint templates. If you want to build a PDF from HTML instead, that is what PDFMint does.',
        docs: '/docs#templates',
      });
  }

  if (sig.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new ApiError(415, 'template_is_legacy_office',
      'That is an old binary Office file (.doc, .xls or .ppt), which DocMint cannot read.', {
        hint: 'Open it in Word, Excel or PowerPoint and use "Save As" to save it as .docx, .xlsx or .pptx, then upload that.',
        docs: '/docs#templates',
      });
  }

  if (sig.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new ApiError(415, 'template_not_office',
      'That file is not a Word, Excel or PowerPoint document — it is not even a zip archive, which all three are.', {
        hint: 'Upload a .docx, .xlsx or .pptx file. If you are sending base64, check it decoded correctly: the first two bytes should be "PK".',
        docs: '/docs#templates',
      });
  }

  let zip;
  try {
    zip = readZip(buffer);
  } catch (e) {
    throw new ApiError(400, 'template_corrupt',
      `The file looks like a zip archive but could not be read: ${e.message}`, {
        hint: 'Re-save the template from Word, Excel or PowerPoint and upload it again. A file that has been through an email gateway or a text-mode transfer is often truncated.',
        docs: '/docs#templates',
      });
  }

  const mimetype = zip.byName.get('mimetype');
  if (mimetype) {
    const mt = readText(mimetype).trim();
    if (mt.startsWith('application/vnd.oasis.opendocument')) {
      const kind = mt.includes('text') ? 'Writer (.odt)' : mt.includes('spreadsheet') ? 'Calc (.ods)' : 'an OpenDocument';
      throw new ApiError(415, 'template_is_opendocument',
        `That is ${kind} file. DocMint fills the Microsoft Office formats: .docx, .xlsx and .pptx.`, {
          hint: 'In LibreOffice, "Save As" and choose the Word/Excel/PowerPoint 2007-365 format.',
          docs: '/docs#templates',
        });
    }
  }

  const ctEntry = zip.byName.get('[Content_Types].xml');
  if (!ctEntry) {
    throw new ApiError(415, 'template_not_office',
      'That zip archive is not an Office document: it has no [Content_Types].xml part.', {
        hint: 'Upload a .docx, .xlsx or .pptx saved from Word, Excel or PowerPoint (or from LibreOffice, Google Docs or Pages exporting to those formats).',
        docs: '/docs#templates',
      });
  }
  const ct = readText(ctEntry);

  for (const [format, needle] of MAIN_TYPES) {
    if (ct.includes(needle)) return { format, zip, macroEnabled: false };
  }
  for (const [format, needle, ext] of MACRO_TYPES) {
    if (ct.includes(needle)) return { format, zip, macroEnabled: true, macroExt: ext };
  }

  throw new ApiError(415, 'template_unknown_office_part',
    'That is an Office package, but not one of the three kinds DocMint fills.', {
      hint: 'Supported: Word (.docx, .dotx), Excel (.xlsx, .xltx) and PowerPoint (.pptx, .potx, .ppsx).',
      docs: '/docs#templates',
    });
}

module.exports = { detect };
