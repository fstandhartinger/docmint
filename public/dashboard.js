/**
 * The dashboard's behaviour: templates, a test render and API keys, all through
 * the session bridge at /dashboard/api/v1 (a cookie plus a CSRF token instead
 * of an API key).
 *
 * Two rules hold everywhere in this file:
 *  - every string that came from the API (template names, labels, error
 *    messages) is put on the page with textContent, so it can never become
 *    markup;
 *  - every control is a real button and every input is labelled, because the
 *    page is driven from a keyboard and a screen reader too.
 */
(function () {
  'use strict';

  var BRIDGE = '/dashboard/api/v1';
  var TEMPLATE_LIMIT_BYTES = 25 * 1024 * 1024;

  var meta = document.querySelector('meta[name="docmint-csrf"]');
  var csrf = meta ? String(meta.content || '') : '';

  function $(id) { return document.getElementById(id); }

  function showError(id, message) {
    var el = $(id);
    if (!el) return;
    if (message) {
      // textContent, always: an API error message echoes user input back.
      el.textContent = message;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  /**
   * Turns an API error body into one readable line. A 422 about a missing
   * field also names the field and the place the template wrote it, because
   * that is the information the fix needs.
   */
  function apiMessage(prefix, body, status) {
    var err = body && body.error;
    var message = err && err.message ? String(err.message) : prefix + ' (HTTP ' + status + ').';
    if (err && err.details && err.details.field) message += ' Field: ' + err.details.field + '.';
    if (err && err.details && err.details.location) message += ' Location: ' + err.details.location + '.';
    return message;
  }

  /** One request against the bridge. The cookie goes by being same-origin. */
  function bridge(path, options) {
    var opts = options || {};
    var headers = { 'X-DocMint-CSRF': csrf };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(BRIDGE + path, {
      method: opts.method || 'GET',
      headers: headers,
      credentials: 'same-origin',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  function readJson(res) {
    return res.json().catch(function () { return null; });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var date = new Date(iso);
    return isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  function cell(row, text) {
    var td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    row.appendChild(td);
    return td;
  }

  /* ------------------------------------------------------------ templates */

  var currentTemplate = null;

  async function loadTemplates() {
    var body = $('templates-body');
    if (!body) return;
    var res;
    try {
      res = await bridge('/templates');
    } catch (e) {
      showError('templates-error', 'The templates could not be loaded.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) {
      showError('templates-error', apiMessage('The templates could not be loaded', data, res.status));
      return;
    }
    showError('templates-error', null);

    var list = (data && data.templates) || [];
    while (body.firstChild) body.removeChild(body.firstChild);
    $('templates-empty').hidden = list.length > 0;
    $('templates-table').hidden = list.length === 0;

    list.forEach(function (t) {
      var tr = document.createElement('tr');
      cell(tr, t.name);
      cell(tr, t.format);
      cell(tr, t.version);
      cell(tr, fmtTime(t.updated_at));
      var actions = document.createElement('td');
      var testButton = document.createElement('button');
      testButton.type = 'button';
      testButton.className = 'secondary';
      testButton.textContent = 'Test render';
      testButton.addEventListener('click', function () { chooseTemplate(t.name); });
      actions.appendChild(testButton);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  /* --------------------------------------------------------------- upload */

  function readFileBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || '');
        var comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = function () { reject(new Error('The file could not be read.')); };
      reader.readAsDataURL(file);
    });
  }

  async function uploadTemplate(event) {
    event.preventDefault();
    showError('upload-error', null);

    var name = $('upload-name').value.trim();
    var fileInput = $('upload-file');
    var file = fileInput.files && fileInput.files[0];
    if (!name) { showError('upload-error', 'Give the template a name.'); return; }
    if (!file) { showError('upload-error', 'Choose a .docx, .xlsx or .pptx file.'); return; }
    if (file.size > TEMPLATE_LIMIT_BYTES) {
      // Word-for-word what the API would answer, so it is the same rejection
      // wherever it happens.
      showError('upload-error', 'That template is ' + (file.size / 1048576).toFixed(1) + ' MB; the limit is 25 MB.');
      return;
    }

    var fileBase64;
    try {
      fileBase64 = await readFileBase64(file);
    } catch (e) {
      showError('upload-error', e.message);
      return;
    }

    var res;
    try {
      res = await bridge('/templates', { method: 'POST', body: { name: name, file_base64: fileBase64 } });
    } catch (e) {
      showError('upload-error', 'The upload failed before it reached the server.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) { showError('upload-error', apiMessage('The upload failed', data, res.status)); return; }

    $('upload-form').reset();
    await loadTemplates();
    if (data && data.name) chooseTemplate(data.name);
  }

  /* ---------------------------------------------------------- test render */

  async function chooseTemplate(name) {
    currentTemplate = { name: name };
    showError('render-error', null);

    var res;
    try {
      res = await bridge('/templates/' + encodeURIComponent(name) + '/fields');
    } catch (e) {
      showError('render-error', 'The template fields could not be loaded.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) {
      showError('render-error', apiMessage('The template fields could not be loaded', data, res.status));
      return;
    }

    $('render-none').hidden = true;
    $('render-detail').hidden = false;
    $('render-name').textContent = data.name;

    var names = (data.fields || []).map(function (f) {
      return (f.scope ? f.scope + '.' : '') + f.name;
    });
    $('render-fields').textContent = names.length
      ? 'Fields: ' + names.join(', ')
      : 'This template has no fields; an empty JSON object is fine.';
    $('render-data').value = JSON.stringify(data.sample_data || {}, null, 2);
  }

  function updateRemaining(remaining) {
    var el = $('credits-remaining');
    if (el) el.textContent = Number(remaining).toLocaleString('en-US');
  }

  async function render(output) {
    if (!currentTemplate) return;
    showError('render-error', null);

    var data;
    try {
      data = JSON.parse($('render-data').value || '{}');
    } catch (e) {
      showError('render-error', 'That JSON does not parse: ' + e.message);
      return;
    }

    var res;
    try {
      res = await bridge('/render', {
        method: 'POST',
        body: { template: currentTemplate.name, data: data, output: output },
      });
    } catch (e) {
      showError('render-error', 'The render failed before it reached the server.');
      return;
    }
    if (!res.ok) {
      showError('render-error', apiMessage('The render failed', await readJson(res), res.status));
      return;
    }

    var remaining = res.headers.get('x-docmint-credits-remaining');
    if (remaining !== null) updateRemaining(remaining);

    var disposition = res.headers.get('content-disposition') || '';
    var match = /filename="?([^";]+)"?/i.exec(disposition);
    var filename = match ? match[1] : currentTemplate.name + (output === 'pdf' ? '.pdf' : '');
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ----------------------------------------------------------------- keys */

  async function loadKeys() {
    var body = $('keys-body');
    if (!body) return;
    var res;
    try {
      res = await bridge('/keys');
    } catch (e) {
      showError('keys-error', 'The keys could not be loaded.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) {
      showError('keys-error', apiMessage('The keys could not be loaded', data, res.status));
      return;
    }
    showError('keys-error', null);

    while (body.firstChild) body.removeChild(body.firstChild);
    ((data && data.keys) || []).forEach(function (k) {
      var tr = document.createElement('tr');
      cell(tr, k.prefix + '…');
      cell(tr, k.label || '');
      cell(tr, fmtTime(k.created_at));
      cell(tr, k.last_used_at ? fmtTime(k.last_used_at) : 'never');
      var actions = document.createElement('td');
      var revokeButton = document.createElement('button');
      revokeButton.type = 'button';
      revokeButton.className = 'secondary';
      revokeButton.textContent = 'Revoke';
      revokeButton.addEventListener('click', function () { revokeKey(k.prefix); });
      actions.appendChild(revokeButton);
      tr.appendChild(actions);
      body.appendChild(tr);
    });
  }

  async function createKey(event) {
    event.preventDefault();
    showError('keys-error', null);
    $('new-key-notice').hidden = true;

    var res;
    try {
      res = await bridge('/keys', { method: 'POST', body: { label: $('key-label').value.trim() || 'default' } });
    } catch (e) {
      showError('keys-error', 'The key could not be created.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) { showError('keys-error', apiMessage('The key could not be created', data, res.status)); return; }

    $('new-key').textContent = data.key || '';
    $('new-key-notice').hidden = false;
    $('key-form').reset();
    await loadKeys();
  }

  async function revokeKey(prefix) {
    if (!window.confirm('Revoke the key ' + prefix + '…? Anything still using it stops working immediately.')) return;
    var res;
    try {
      res = await bridge('/keys/' + encodeURIComponent(prefix), { method: 'DELETE' });
    } catch (e) {
      showError('keys-error', 'The key could not be revoked.');
      return;
    }
    var data = await readJson(res);
    if (!res.ok) { showError('keys-error', apiMessage('The key could not be revoked', data, res.status)); return; }
    showError('keys-error', null);
    await loadKeys();
  }

  function copyNewKey() {
    var button = $('new-key-copy');
    navigator.clipboard.writeText($('new-key').textContent).then(function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy'; }, 1500);
    });
  }

  /* --------------------------------------------------------------- wiring */

  function init() {
    if (!csrf) return; // Not on the dashboard page.
    $('upload-form').addEventListener('submit', uploadTemplate);
    $('render-doc').addEventListener('click', function () { render('document'); });
    $('render-pdf').addEventListener('click', function () { render('pdf'); });
    $('key-form').addEventListener('submit', createKey);
    $('new-key-copy').addEventListener('click', copyNewKey);
    loadTemplates();
    loadKeys();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
