'use strict';

const { decodeXml, escapeXml, stripInvalidXmlChars, findElements, attr, setAttr, applyEdits } = require('./xml');

/**
 * Run-aware text editing — the reason this product works on real templates.
 *
 * Word and PowerPoint do not store a paragraph as one string. They store it as a
 * sequence of runs, and they split runs for reasons that have nothing to do with
 * what the text looks like: the author put the cursor in the middle of a word,
 * spellcheck marked a squiggle, the file went through Google Docs, a language tag
 * changed. So a placeholder someone typed as one word:
 *
 *     {{invoice_number}}
 *
 * is very often stored as:
 *
 *     <w:r><w:t>{{invoice</w:t></w:r>
 *     <w:r w:rsidR="00A1"><w:t>_num</w:t></w:r>
 *     <w:r><w:t>ber}}</w:t></w:r>
 *
 * Every naive implementation — and that is most of them — does a string replace on
 * each run in turn, finds nothing, and silently emits the template unchanged. The
 * user opens the document, sees `{{invoice_number}}` where the number should be,
 * and concludes the product is broken. They are right.
 *
 * So: flatten the paragraph's text nodes into one string, work in that coordinate
 * space, then map the edits back onto the nodes. A replacement is written entirely
 * into the node that held the tag's FIRST character, so it inherits that run's
 * formatting — which is what the author intended when they styled the placeholder.
 */

/**
 * Reads every text node inside `xml` in document order.
 *
 * @param {string} xml         a paragraph (or any fragment)
 * @param {string} textTag     'w:t' for WordprocessingML, 'a:t' for DrawingML
 * @returns {{text: string, nodes: Array}} `text` is the concatenated, entity-decoded
 *   content; each node records where its content sits in `xml` and which slice of
 *   `text` it contributed.
 */
function flatten(xml, textTag) {
  const nodes = [];
  let text = '';
  for (const el of findElements(xml, textTag)) {
    const decoded = el.selfClosing ? '' : decodeXml(xml.slice(el.contentStart, el.contentEnd));
    nodes.push({
      start: el.start,
      end: el.end,
      openEnd: el.openEnd,
      openTag: el.openTag,
      contentStart: el.contentStart,
      contentEnd: el.contentEnd,
      selfClosing: el.selfClosing,
      textStart: text.length,
      textEnd: text.length + decoded.length,
      decoded,
    });
    text += decoded;
  }
  return { text, nodes };
}

/**
 * Rewrites `xml` so that the text ranges named in `edits` are replaced.
 *
 * @param {Array<{start:number,end:number,text:string}>} edits  offsets into the
 *   flattened text; `text` is the literal replacement, already run through
 *   `encode` if it needs to become markup (line breaks, for instance).
 * @param {(s:string)=>string} [encode]  turns a plain replacement string into XML
 *   content. Defaults to escaping. DOCX passes one that turns "\n" into `<w:br/>`.
 */
function splice(xml, flat, edits, encode) {
  if (!edits.length) return xml;
  const enc = encode || ((s) => escapeXml(stripInvalidXmlChars(s)));
  const sorted = [...edits].sort((a, b) => a.start - b.start);

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(`overlapping text edits: ${sorted[i - 1].start}..${sorted[i - 1].end} and ${sorted[i].start}..${sorted[i].end}`);
    }
  }

  const xmlEdits = [];
  for (const node of flat.nodes) {
    const touching = sorted.filter((e) => e.end > node.textStart && e.start < node.textEnd
      // A zero-length edit (a tag replaced by nothing, or an insertion) still
      // belongs to the node whose range contains its start.
      || (e.start === e.end && e.start >= node.textStart && e.start < node.textEnd));
    if (!touching.length) continue;

    let out = '';
    let pos = node.textStart;
    for (const e of touching) {
      if (e.start > pos) out += enc(node.decoded.slice(pos - node.textStart, e.start - node.textStart));
      // The replacement lands only in the node holding the edit's first character.
      if (e.start >= node.textStart && e.start < node.textEnd) out += e.text;
      else if (e.start === node.textEnd && e.start === e.end) out += e.text;
      pos = Math.max(pos, Math.min(e.end, node.textEnd));
    }
    if (pos < node.textEnd) out += enc(node.decoded.slice(pos - node.textStart));

    xmlEdits.push(replacementFor(node, out));
  }
  return applyEdits(xml, xmlEdits);
}

/**
 * Builds the XML edit that puts `content` inside one text node.
 *
 * Two things have to be right here or Word quietly mangles the output:
 *  - a self-closing `<w:t/>` has no content range, so it must become a pair;
 *  - leading or trailing whitespace is discarded unless `xml:space="preserve"`
 *    is present, which is how "Dear  {name}" loses its space and nobody can work
 *    out why.
 */
function replacementFor(node, content) {
  const needsPreserve = /^\s|\s$/.test(stripTags(content));
  if (node.selfClosing) {
    let open = node.openTag.slice(0, -2) + '>';
    if (needsPreserve) open = setAttr(open, 'xml:space', 'preserve');
    const tagName = /^<([^\s/>]+)/.exec(node.openTag)[1];
    return { start: node.start, end: node.end, text: `${open}${content}</${tagName}>` };
  }
  let open = node.openTag;
  if (needsPreserve && !attr(open, 'xml:space')) open = setAttr(open, 'xml:space', 'preserve');
  return { start: node.start, end: node.contentEnd, text: `${open}${content}` };
}

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/**
 * Removes every text node's content from a fragment, leaving the runs and their
 * formatting in place. Used when a paragraph is consumed entirely by a section
 * marker and should vanish without taking its neighbours' formatting with it.
 */
function blankText(xml, textTag) {
  const flat = flatten(xml, textTag);
  if (!flat.nodes.length) return xml;
  return splice(xml, flat, [{ start: 0, end: flat.text.length, text: '' }]);
}

module.exports = { flatten, splice, blankText, replacementFor };
