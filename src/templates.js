'use strict';

const crypto = require('node:crypto');

const { query, tx } = require('./db');
const { ApiError, bad } = require('./errors');
const { config, FORMATS } = require('./config');
const { detect } = require('./render/detect');
const log = require('./log');

/**
 * Template storage.
 *
 * Two decisions worth explaining.
 *
 * Templates are addressed by a NAME the caller chooses, not by an opaque id. The
 * competing products all hand you a UUID, which means the id has to be pasted
 * into the workflow, and replacing the template means editing every workflow that
 * used it. A workflow that says `template: "invoice"` keeps working when the
 * finance team uploads a new letterhead. The id still exists for anyone who wants
 * it, and both work everywhere a template is named.
 *
 * Every upload is a new VERSION rather than an overwrite. A template is a thing a
 * business depends on; discovering an hour after replacing one that the old one
 * was better must be recoverable. Versions are pruned to `maxVersionsKept`, oldest
 * first, and never below one.
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

function normaliseName(raw) {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!name) {
    throw bad('missing_template_name', 'A template needs a name.', {
      hint: 'Send "name": "invoice". Lower case letters, digits, dot, dash and underscore, 1 to 64 characters.',
      docs: '/docs#templates',
    });
  }
  if (!NAME_RE.test(name)) {
    throw bad('bad_template_name', `"${raw}" is not a usable template name.`, {
      hint: 'Use lower case letters, digits, dot, dash and underscore; 1 to 64 characters; start and end with a letter or digit. For example "invoice" or "quarterly-report".',
      docs: '/docs#templates',
    });
  }
  return name;
}

const newTemplateId = () => `tpl_${crypto.randomBytes(9).toString('base64url')}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Looks a template up by name or by id, whichever the caller sent. */
async function find(accountId, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  const byId = key.startsWith('tpl_');
  const { rows } = await query(
    byId
      ? `SELECT * FROM templates WHERE account_id = $1 AND id = $2`
      : `SELECT * FROM templates WHERE account_id = $1 AND name = $2`,
    [accountId, byId ? key : key.toLowerCase()],
  );
  return rows[0] || null;
}

/**
 * Not finding a template is the most common error on this API, so it gets the
 * most careful message: what you asked for, what you have, and how to make one.
 */
async function findOrThrow(accountId, ref) {
  const found = await find(accountId, ref);
  if (found) return found;
  const { rows } = await query(
    `SELECT name, format FROM templates WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 12`, [accountId],
  );
  throw new ApiError(404, 'template_not_found', `You have no template called "${ref}".`, {
    hint: rows.length
      ? `Templates on this account: ${rows.map((r) => `${r.name} (${r.format})`).join(', ')}.`
      : 'This account has no templates yet. Upload one with POST /v1/templates, or skip templates entirely and send the file inline as "template_base64" on the render call.',
    details: { available: rows.map((r) => r.name) },
    docs: '/docs#templates',
  });
}

/**
 * Creates a template, or adds a version to an existing one. Idempotent on
 * content: re-uploading bytes identical to the current version does not burn a
 * version number, because a workflow that syncs a template on every run should
 * not fill the history with copies of the same file.
 */
async function upload(account, { name, buffer, description, note, inspectFields }) {
  const templateName = normaliseName(name);

  if (buffer.length > config.maxTemplateBytes) {
    throw bad('template_too_large',
      `That template is ${(buffer.length / 1048576).toFixed(1)} MB; the limit is ${(config.maxTemplateBytes / 1048576).toFixed(0)} MB.`, {
        hint: 'Most of the size in a large Office file is embedded images. Compressing them in Word or PowerPoint ("Compress Pictures") usually takes a template well under the limit.',
        docs: '/docs#limits',
      });
  }

  // Detect before storing: a file that cannot be filled should be refused at
  // upload, when the user is looking at the response, rather than at 3am when a
  // workflow runs.
  const { format, macroEnabled } = detect(buffer);
  const digest = sha256(buffer);

  return tx(async (client) => {
    const { rows: existing } = await client.query(
      `SELECT * FROM templates WHERE account_id = $1 AND name = $2 FOR UPDATE`, [account.id, templateName],
    );

    let template = existing[0];
    if (template && template.format !== format) {
      throw new ApiError(409, 'template_format_changed',
        `"${templateName}" is a ${FORMATS[template.format].name} template, but the file you uploaded is a ${FORMATS[format].name}.`, {
          hint: `Changing the format of a template would break every workflow using it. Upload this under a different name, or delete "${templateName}" first.`,
          docs: '/docs#templates',
        });
    }

    if (!template) {
      const id = newTemplateId();
      const { rows } = await client.query(
        `INSERT INTO templates (id, account_id, name, format, version, description)
         VALUES ($1, $2, $3, $4, 0, $5) RETURNING *`,
        [id, account.id, templateName, format, description ?? null],
      );
      template = rows[0];
    } else if (description !== undefined) {
      await client.query(`UPDATE templates SET description = $2 WHERE id = $1`, [template.id, description]);
      template.description = description;
    }

    const { rows: current } = await client.query(
      `SELECT version, sha256 FROM template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1`, [template.id],
    );
    if (current[0] && current[0].sha256 === digest) {
      log.info('template.upload.unchanged', { template_id: template.id, name: templateName, version: current[0].version });
      return { template, version: current[0].version, unchanged: true, format, macroEnabled };
    }

    const version = (current[0]?.version || 0) + 1;
    const fields = inspectFields || { fields: [], tags: [] };
    await client.query(
      `INSERT INTO template_versions (template_id, version, bytes, size, sha256, fields, tags, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [template.id, version, buffer, buffer.length, digest,
        JSON.stringify(fields.fields || []), JSON.stringify(fields.tags || []), note ?? null],
    );
    await client.query(`UPDATE templates SET version = $2, updated_at = now() WHERE id = $1`, [template.id, version]);

    // Prune oldest, never below one, so the history cannot grow without bound on
    // a workflow that re-uploads every run.
    await client.query(
      `DELETE FROM template_versions WHERE template_id = $1 AND version <= (
         SELECT COALESCE(MAX(version), 0) - $2 FROM template_versions WHERE template_id = $1)`,
      [template.id, config.maxVersionsKept],
    );

    template.version = version;
    log.info('template.upload.ok', {
      template_id: template.id, name: templateName, format, version, bytes: buffer.length, macro: macroEnabled,
    });
    return { template, version, unchanged: false, format, macroEnabled };
  });
}

/** Fetches the bytes of one version — the current one unless a version is named. */
async function bytesOf(template, version) {
  const v = version === undefined || version === null || version === '' ? null : Number(version);
  if (v !== null && (!Number.isInteger(v) || v < 1)) {
    throw bad('bad_version', `"${version}" is not a version number.`, {
      hint: `Versions are whole numbers from 1 to ${template.version}. Leave it out for the current version.`,
      docs: '/docs#template-versions',
    });
  }
  const { rows } = await query(
    v === null
      ? `SELECT * FROM template_versions WHERE template_id = $1 ORDER BY version DESC LIMIT 1`
      : `SELECT * FROM template_versions WHERE template_id = $1 AND version = $2`,
    v === null ? [template.id] : [template.id, v],
  );
  if (!rows.length) {
    const { rows: have } = await query(
      `SELECT version FROM template_versions WHERE template_id = $1 ORDER BY version DESC`, [template.id],
    );
    throw new ApiError(404, 'template_version_not_found',
      `"${template.name}" has no version ${v}.`, {
        hint: have.length
          ? `Versions still stored: ${have.map((r) => r.version).join(', ')}. Only the most recent ${config.maxVersionsKept} are kept.`
          : 'This template has no stored versions at all, which should not happen — please report it.',
        docs: '/docs#template-versions',
      });
  }
  return rows[0];
}

async function list(accountId) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.format, t.version, t.description, t.created_at, t.updated_at,
            v.size, v.sha256, v.fields
     FROM templates t
     LEFT JOIN LATERAL (
       SELECT size, sha256, fields FROM template_versions
       WHERE template_id = t.id ORDER BY version DESC LIMIT 1
     ) v ON true
     WHERE t.account_id = $1 ORDER BY t.name`,
    [accountId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    format: r.format,
    version: r.version,
    description: r.description,
    size: Number(r.size || 0),
    sha256: r.sha256,
    fields: r.fields || [],
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

async function versionsOf(templateId) {
  const { rows } = await query(
    `SELECT version, size, sha256, note, created_at, jsonb_array_length(fields) AS field_count
     FROM template_versions WHERE template_id = $1 ORDER BY version DESC`, [templateId],
  );
  return rows.map((r) => ({
    version: r.version, size: Number(r.size), sha256: r.sha256, note: r.note,
    fields: Number(r.field_count), created_at: r.created_at,
  }));
}

async function remove(accountId, ref) {
  const template = await findOrThrow(accountId, ref);
  await query(`DELETE FROM templates WHERE id = $1`, [template.id]);
  log.info('template.delete', { template_id: template.id, name: template.name });
  return template;
}

/**
 * Rolling back copies an old version forward as a NEW version rather than
 * deleting the ones after it. Nothing is lost, and a rollback made in a panic can
 * itself be rolled back.
 */
async function rollback(account, ref, toVersion) {
  const template = await findOrThrow(account.id, ref);
  const source = await bytesOf(template, toVersion);
  const out = await upload(account, {
    name: template.name,
    buffer: source.bytes,
    note: `rolled back to version ${source.version}`,
    inspectFields: { fields: source.fields, tags: source.tags },
  });
  log.info('template.rollback', { template_id: template.id, from: template.version, to: source.version, new_version: out.version });
  return { ...out, restoredFrom: source.version };
}

module.exports = { upload, find, findOrThrow, bytesOf, list, versionsOf, remove, rollback, normaliseName, sha256, newTemplateId };
