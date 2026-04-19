/**
 * Repackaging currency ingest — Apps Script web app (doPost).
 *
 * Accepts one POST per batch from repackaging_planner.html. The payload consolidates
 * every input + every output into a single request.
 *
 * Flow:
 * 1) Append ONE row to "Telegram Chat Logs" (ops spreadsheet) — the whole batch as JSON.
 * 2) Append N rows to "Currency Creation" (same ops spreadsheet) — one per output, keyed by {request_id}#{index}.
 * 3) Append N rows to "Currencies" (Main Ledger) — one per output, with:
 *    column A = suggested_currency
 *    column B = cost_per_output_usd (CURRENCIES_UNIT_COST_USD_COLUMN, default 2)
 *    column N = raw_request_text (CURRENCIES_RAW_REQUEST_COLUMN, default 14)
 *    column O = composition JSON raw URL (CURRENCIES_COMPOSITION_JSON_URL_COLUMN, default 15)
 *    then sort body rows by column A ascending. If the composition-URL column resolves to the
 *    same column as the raw-text column, the URL is skipped (raw text wins).
 * 4) Rebuild public currencies.json in TrueSightDAO/agroverse-inventory via GitHub Contents API.
 * 5) Write one composition file: currency-compositions/{request_id}.json (inputs, outputs, totals).
 *
 * Script properties:
 * - AGROVERSE_INVENTORY_PUBLISH_SECRET (required)
 * - AGROVERSE_INVENTORY_CURRENCIES_PAT (required for GitHub; falls back to AGROVERSE_INVENTORY_GIT_REPO_UPDATE_PAT)
 * Optional overrides:
 * - AGROVERSE_INVENTORY_GITHUB_OWNER (default TrueSightDAO)
 * - AGROVERSE_INVENTORY_GITHUB_REPO (default agroverse-inventory)
 * - AGROVERSE_INVENTORY_GITHUB_BRANCH (default main)
 * - AGROVERSE_INVENTORY_CURRENCIES_JSON_PATH (default currencies.json)
 * - REPACKAGING_COMPOSITIONS_DIR (default currency-compositions)
 * - REPACKAGING_OPS_SPREADSHEET_ID (default 1qbZZhf-…)
 * - REPACKAGING_MAIN_SPREADSHEET_ID (default 1GE7PUq-…)
 * - SHEET_TELEGRAM_CHAT_LOGS (default Telegram Chat Logs)
 * - SHEET_CURRENCY_CREATION (default Currency Creation)
 * - SHEET_CURRENCIES (default Currencies)
 * - CURRENCIES_UNIT_COST_USD_COLUMN (default 2 = column B) — per-output USD price.
 * - CURRENCIES_RAW_REQUEST_COLUMN (default 14 = column N) — raw text of the original request. Set 0 to skip.
 * - CURRENCIES_COMPOSITION_JSON_URL_COLUMN (default 15 = column O) — raw.githubusercontent.com …/currency-compositions/{request_id}.json.
 *   Set 0 to skip. If this resolves to the same column as CURRENCIES_RAW_REQUEST_COLUMN the URL is skipped (raw text wins).
 */
var SCRIPT_PROP_PUBLISH_SECRET = 'AGROVERSE_INVENTORY_PUBLISH_SECRET';
var SCRIPT_PROP_PAT_PRIMARY = 'AGROVERSE_INVENTORY_CURRENCIES_PAT';
var SCRIPT_PROP_PAT_FALLBACK = 'AGROVERSE_INVENTORY_GIT_REPO_UPDATE_PAT';
var SCRIPT_PROP_GH_OWNER = 'AGROVERSE_INVENTORY_GITHUB_OWNER';
var SCRIPT_PROP_GH_REPO = 'AGROVERSE_INVENTORY_GITHUB_REPO';
var SCRIPT_PROP_GH_BRANCH = 'AGROVERSE_INVENTORY_GITHUB_BRANCH';
var SCRIPT_PROP_GH_PATH = 'AGROVERSE_INVENTORY_CURRENCIES_JSON_PATH';
var SCRIPT_PROP_COMPOSITIONS_DIR = 'REPACKAGING_COMPOSITIONS_DIR';
var SCRIPT_PROP_OPS_SS = 'REPACKAGING_OPS_SPREADSHEET_ID';
var SCRIPT_PROP_MAIN_SS = 'REPACKAGING_MAIN_SPREADSHEET_ID';
var SCRIPT_PROP_SHEET_LOGS = 'SHEET_TELEGRAM_CHAT_LOGS';
var SCRIPT_PROP_SHEET_CC = 'SHEET_CURRENCY_CREATION';
var SCRIPT_PROP_SHEET_CUR = 'SHEET_CURRENCIES';
var SCRIPT_PROP_CURRENCIES_UNIT_COST_COL = 'CURRENCIES_UNIT_COST_USD_COLUMN';
var SCRIPT_PROP_CURRENCIES_RAW_REQ_COL = 'CURRENCIES_RAW_REQUEST_COLUMN';
var SCRIPT_PROP_CURRENCIES_COMP_URL_COL = 'CURRENCIES_COMPOSITION_JSON_URL_COLUMN';

var DEFAULT_OPS_SPREADSHEET_ID = '1qbZZhf-_7xzmDTriaJVWj6OZshyQsFkdsAV8-pyzASQ';
var DEFAULT_MAIN_SPREADSHEET_ID = '1GE7PUq-UT6x2rBN-Q2ksogbWpgyuh2SaxJyG_uEK6PU';
var DEFAULT_SHEET_LOGS = 'Telegram Chat Logs';
var DEFAULT_SHEET_CC = 'Currency Creation';
var DEFAULT_SHEET_CUR = 'Currencies';
var DEFAULT_GH_PATH = 'currencies.json';
var DEFAULT_COMPOSITIONS_DIR = 'currency-compositions';
var DEFAULT_CURRENCIES_UNIT_COST_COL = 2;
var DEFAULT_CURRENCIES_RAW_REQ_COL = 14;
var DEFAULT_CURRENCIES_COMP_URL_COL = 15;

function getProp_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v && String(v).trim()) ? String(v).trim() : fallback;
}

function getPat_() {
  var p = PropertiesService.getScriptProperties();
  return (
    p.getProperty(SCRIPT_PROP_PAT_PRIMARY) ||
    p.getProperty(SCRIPT_PROP_PAT_FALLBACK) ||
    ''
  ).trim();
}

function getIntProp_(key, fallback) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (raw == null || String(raw).trim() === '') return fallback;
  var n = parseInt(String(raw).trim(), 10);
  if (isNaN(n) || n < 0) return fallback;
  return n;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = (e && e.parameter ? String(e.parameter.action || '') : '').trim();
  if (action === 'processRepackagingBatchesFromTelegramChatLogs') {
    return processRepackagingBatchesFromTelegramChatLogs_();
  }
  return jsonResponse_({
    ok: true,
    service: 'repackaging-currency-ingest',
    schema_version: 2,
    hint: 'GET ?action=processRepackagingBatchesFromTelegramChatLogs to scan Telegram Chat Logs for [REPACKAGING BATCH EVENT] rows (Edgar-driven flow). Legacy direct POSTs still work: POST JSON { token, request_id, event, holder_key, holder_label, inputs[], outputs[], totals, raw_request_text, composition, conversion_proof? }.',
  });
}

/** One-time: run this in the editor to authorize UrlFetch + Spreadsheets. */
function authorizeUrlFetchForRepackagingIngest() {
  UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true });
  SpreadsheetApp.openById(getProp_(SCRIPT_PROP_OPS_SS, DEFAULT_OPS_SPREADSHEET_ID)).getName();
}

/**
 * Legacy direct-POST entrypoint (token-authenticated). Still works so anything
 * that was POSTing straight to /exec continues to function, but the canonical
 * flow is now DApp → Edgar submit_contribution → Telegram Chat Logs → this
 * script's doGet triggered by Edgar.
 */
function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var data;
    try {
      data = JSON.parse(body);
    } catch (ignore) {
      return jsonResponse_({ ok: false, error: 'Invalid JSON body' });
    }

    var secret = getProp_(SCRIPT_PROP_PUBLISH_SECRET, '');
    if (!secret || String(data.token || '') !== secret) {
      return jsonResponse_({ ok: false, error: 'Unauthorized' });
    }

    var opsId = getProp_(SCRIPT_PROP_OPS_SS, DEFAULT_OPS_SPREADSHEET_ID);
    var shLogsName = getProp_(SCRIPT_PROP_SHEET_LOGS, DEFAULT_SHEET_LOGS);
    var opsSs = SpreadsheetApp.openById(opsId);
    var event = String(data.event || 'repackaging_batch_creation');
    var sanitized = sanitizePayloadForSheets_(data);
    // Legacy path: append the raw payload to Chat Logs for audit (Edgar path is written by Edgar instead).
    appendRow_(opsSs, shLogsName, [new Date().toISOString(), 'repackaging_planner', event, JSON.stringify(sanitized)]);

    var result = processBatchData_(data);
    return jsonResponse_(result);
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Scan Telegram Chat Logs (rows 3..last, column G) for [REPACKAGING BATCH EVENT] rows,
 * decode the base64 JSON payload, and process any that haven't been processed yet
 * (deduped via Currency Creation column B).
 */
function processRepackagingBatchesFromTelegramChatLogs_() {
  try {
    var opsId = getProp_(SCRIPT_PROP_OPS_SS, DEFAULT_OPS_SPREADSHEET_ID);
    var shLogsName = getProp_(SCRIPT_PROP_SHEET_LOGS, DEFAULT_SHEET_LOGS);
    var shCcName = getProp_(SCRIPT_PROP_SHEET_CC, DEFAULT_SHEET_CC);
    var opsSs = SpreadsheetApp.openById(opsId);
    var shLogs = opsSs.getSheetByName(shLogsName);
    if (!shLogs) return jsonResponse_({ ok: false, error: 'Missing sheet: ' + shLogsName });

    var lastRow = shLogs.getLastRow();
    if (lastRow < 3) return jsonResponse_({ ok: true, action: 'processRepackagingBatchesFromTelegramChatLogs', scanned: 0, processed: 0, duplicates: 0, failed: 0 });

    // Column G (7) holds the submitted text (Gdrive::TelegramRawLog#add_record writes it there).
    var numRows = lastRow - 2;
    var values = shLogs.getRange(3, 7, numRows, 1).getValues();

    var scanned = 0, processed = 0, duplicates = 0, failed = 0;
    var errors = [];
    var processedRequestIds = [];

    for (var i = 0; i < values.length; i++) {
      var text = String(values[i][0] || '');
      if (text.indexOf('[REPACKAGING BATCH EVENT]') === -1) continue;
      scanned++;
      var rowNumber = i + 3;

      var reqMatch = text.match(/- Request ID:\s*(\S+)/);
      if (!reqMatch) { failed++; errors.push('row ' + rowNumber + ': no Request ID'); continue; }
      var requestId = reqMatch[1].trim();

      if (requestIdExists_(opsSs, shCcName, requestId)) {
        duplicates++;
        continue;
      }

      var b64Match = text.match(/- Batch Payload \(base64 JSON\):\s*([A-Za-z0-9+/=]+)/);
      if (!b64Match) { failed++; errors.push('row ' + rowNumber + ': no Batch Payload'); continue; }

      var data;
      try {
        var bytes = Utilities.base64Decode(b64Match[1]);
        var jsonStr = Utilities.newBlob(bytes).getDataAsString('UTF-8');
        data = JSON.parse(jsonStr);
      } catch (parseErr) {
        failed++;
        errors.push('row ' + rowNumber + ': payload decode failed — ' + parseErr.message);
        continue;
      }
      if (!data.request_id) data.request_id = requestId;

      try {
        var result = processBatchData_(data);
        if (result && result.ok && !result.duplicate) {
          processed++;
          processedRequestIds.push(requestId);
        } else if (result && result.duplicate) {
          duplicates++;
        } else {
          failed++;
          errors.push('row ' + rowNumber + ': ' + ((result && result.error) || 'processBatchData_ returned non-ok'));
        }
      } catch (procErr) {
        failed++;
        errors.push('row ' + rowNumber + ': ' + procErr.message);
      }
    }

    return jsonResponse_({
      ok: true,
      action: 'processRepackagingBatchesFromTelegramChatLogs',
      total_rows_in_sheet: lastRow,
      scanned: scanned,
      processed: processed,
      duplicates: duplicates,
      failed: failed,
      processed_request_ids: processedRequestIds,
      errors: errors,
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * Core processing: given a decoded batch data object, write Currency Creation rows,
 * Currencies rows, rebuild currencies.json, write composition JSON to GitHub.
 * Does NOT write to Telegram Chat Logs (the caller owns that — Edgar in the
 * webhook flow, doPost legacy flow in direct submits).
 */
function processBatchData_(data) {
  var requestId = String(data.request_id || '').trim() || Utilities.getUuid();
  var outputs = Array.isArray(data.outputs) ? data.outputs : [];
  if (!outputs.length) return { ok: false, error: 'outputs[] is required and must be non-empty' };
  for (var i = 0; i < outputs.length; i++) {
    var o = outputs[i] || {};
    if (!o.suggested_currency || !String(o.suggested_currency).trim()) {
      return { ok: false, error: 'outputs[' + i + '].suggested_currency is required' };
    }
  }

  var opsId = getProp_(SCRIPT_PROP_OPS_SS, DEFAULT_OPS_SPREADSHEET_ID);
  var mainId = getProp_(SCRIPT_PROP_MAIN_SS, DEFAULT_MAIN_SPREADSHEET_ID);
  var shCc = getProp_(SCRIPT_PROP_SHEET_CC, DEFAULT_SHEET_CC);
  var shCur = getProp_(SCRIPT_PROP_SHEET_CUR, DEFAULT_SHEET_CUR);

  var opsSs = SpreadsheetApp.openById(opsId);

  if (requestIdExists_(opsSs, shCc, requestId)) {
    return { ok: true, duplicate: true, request_id: requestId, message: 'request_id already processed' };
  }

  var now = new Date();
  var iso = now.toISOString();
  var sanitized = sanitizePayloadForSheets_(data);
  var rawRequestText = String(data.raw_request_text || '').trim() || buildRawRequestTextFromData_(data, requestId, iso);
  var holderCell = String(data.holder_label || data.holder_key ||
    (data.composition && data.composition.holder && (data.composition.holder.label || data.composition.holder.key)) || '').trim();

  // N rows to Currency Creation, keyed {request_id}#{idx}.
  outputs.forEach(function (o, idx) {
    var subId = requestId + '#' + idx;
    var perOutputJson = JSON.stringify(buildPerOutputLogPayload_(sanitized, o, idx));
    appendRow_(opsSs, shCc, [iso, subId, o.suggested_currency, o.unit_cost_usd, holderCell, perOutputJson]);
  });

  var compPath = compositionFilePath_(requestId);
  var compositionRawUrl = rawGithubFileUrl_(compPath);

  var mainSs = SpreadsheetApp.openById(mainId);
  var costCol = getIntProp_(SCRIPT_PROP_CURRENCIES_UNIT_COST_COL, DEFAULT_CURRENCIES_UNIT_COST_COL);
  var rawCol = getIntProp_(SCRIPT_PROP_CURRENCIES_RAW_REQ_COL, DEFAULT_CURRENCIES_RAW_REQ_COL);
  var compUrlCol = getIntProp_(SCRIPT_PROP_CURRENCIES_COMP_URL_COL, DEFAULT_CURRENCIES_COMP_URL_COL);
  var effectiveCompUrlCol = (compUrlCol >= 1 && compUrlCol !== rawCol) ? compUrlCol : 0;
  var rowsAdded = appendCurrencyRowsAndSort_(mainSs, shCur, outputs, rawRequestText, compositionRawUrl, costCol, rawCol, effectiveCompUrlCol);

  var list = readCurrencyStringsFromSheet_(mainSs, shCur);
  var gh = publishCurrenciesJsonToGitHub_(list);

  var compDoc = buildCanonicalComposition_(data, requestId, iso);
  var ghComp = putGitHubJsonAtPath_(compPath, 'chore(inventory): repackaging composition ' + requestId, compDoc);

  return {
    ok: true,
    request_id: requestId,
    outputs_count: outputs.length,
    currencies_rows_added: rowsAdded,
    currency_creation_rows: outputs.length,
    currencies_count: list.length,
    currencies_sheet_unit_cost_column: costCol,
    currencies_sheet_raw_request_column: rawCol,
    currencies_sheet_composition_url_column: effectiveCompUrlCol,
    composition_raw_url: compositionRawUrl,
    github: gh,
    github_composition: { ok: ghComp.ok, path: compPath, message: ghComp.message, sha: ghComp.sha },
  };
}

/**
 * Reconstructs a human-readable raw request text from the decoded data object
 * when the caller didn't supply one (Edgar flow — the data comes from a
 * base64 JSON payload inside the [REPACKAGING BATCH EVENT] text).
 */
function buildRawRequestTextFromData_(data, requestId, iso) {
  var c = (data && data.composition) || {};
  var holder = (c.holder && (c.holder.label || c.holder.key)) ||
    data.holder_label || data.holder_key || '(unset)';
  var inputs = Array.isArray(data.inputs) ? data.inputs :
    (Array.isArray(c.inputs) ? c.inputs : []);
  var outputs = Array.isArray(data.outputs) ? data.outputs :
    (Array.isArray(c.outputs) ? c.outputs : []);
  var totals = (data.totals && typeof data.totals === 'object') ? data.totals :
    (c.totals && typeof c.totals === 'object' ? c.totals : {});

  var lines = [];
  lines.push('[' + requestId + '] ' + iso);
  lines.push('Holder: ' + holder);
  lines.push('');
  lines.push('Inputs:');
  inputs.forEach(function (r) {
    var tag = (r && r.line_kind === 'custom') ? ' [custom]' : '';
    var qty = (r && r.quantity != null) ? r.quantity : '?';
    var uc = (r && r.unit_cost_usd != null) ? Number(r.unit_cost_usd).toFixed(4) : '?';
    var ext = (r && r.extended_cost_usd != null) ? Number(r.extended_cost_usd).toFixed(4) : '?';
    lines.push('- ' + ((r && r.currency) || '?') + tag + ' (' + qty + ' × $' + uc + ' = $' + ext + ')');
  });
  if (totals.inputs_subtotal_usd != null) lines.push('Inputs total: $' + Number(totals.inputs_subtotal_usd).toFixed(4));
  lines.push('');
  lines.push('Outputs:');
  outputs.forEach(function (o) {
    var wd = (o && o.weight_display) ? (o.weight_display.amount + ' ' + o.weight_display.unit) :
      ((o && o.weight_per_unit_grams != null) ? (o.weight_per_unit_grams + ' g') : '?');
    var M = (o && o.units != null) ? o.units : '?';
    var uc = (o && o.unit_cost_usd != null) ? Number(o.unit_cost_usd).toFixed(4) : '?';
    var line = (o && o.line_total_usd != null) ? Number(o.line_total_usd).toFixed(4) : '?';
    lines.push('- ' + ((o && o.suggested_currency) || '?') + ' (' + M + ' × ' + wd + ' → $' + uc + '/unit, line $' + line + ')');
  });
  if (totals.total_output_weight_grams != null) {
    var g = Number(totals.total_output_weight_grams);
    lines.push('Total finished weight: ' + (g >= 1000 ? (g / 1000).toFixed(2) + ' kg' : g.toFixed(1) + ' g'));
  }
  if (totals.cost_per_gram_usd != null) lines.push('Cost per gram: $' + Number(totals.cost_per_gram_usd).toFixed(6));
  return lines.join('\n');
}

/* ---------------- helpers ---------------- */

function appendRow_(ss, sheetName, row) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Missing sheet: ' + sheetName);
  sh.appendRow(row);
}

/**
 * Column B on Currency Creation holds request_id (row 2+). Match either:
 *   - exact (e.g. "req_abc" for legacy single-output rows), or
 *   - prefix "req_abc#" (this batch’s multi-output keys).
 */
function requestIdExists_(ss, sheetName, requestId) {
  if (!requestId) return false;
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return false;
  var last = sh.getLastRow();
  if (last < 2) return false;
  var vals = sh.getRange(2, 2, last - 1, 1).getValues();
  var target = String(requestId).trim();
  var prefix = target + '#';
  for (var i = 0; i < vals.length; i++) {
    var cell = vals[i][0];
    if (cell == null) continue;
    var s = String(cell).trim();
    if (s === target || s.indexOf(prefix) === 0) return true;
  }
  return false;
}

function buildPerOutputLogPayload_(sanitizedBatch, output, index) {
  return {
    request_id: sanitizedBatch.request_id,
    output_index: index,
    output: output,
    holder: { key: sanitizedBatch.holder_key || null, label: sanitizedBatch.holder_label || null },
    totals: sanitizedBatch.totals || null,
  };
}

function rawGithubFileUrl_(repoRelativePath) {
  var owner = getProp_(SCRIPT_PROP_GH_OWNER, 'TrueSightDAO');
  var repo = getProp_(SCRIPT_PROP_GH_REPO, 'agroverse-inventory');
  var branch = getProp_(SCRIPT_PROP_GH_BRANCH, 'main');
  var path = String(repoRelativePath || '').replace(/^\/+/, '');
  return 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + path;
}

/**
 * Append one Currencies row per output; write unit cost, raw request text, and composition URL
 * to their configured columns; then sort body rows (row 2..last) by column A ascending.
 * @return number of rows added
 */
function appendCurrencyRowsAndSort_(ss, sheetName, outputs, rawRequestText, compositionRawUrl, costCol, rawCol, compUrlCol) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Missing sheet: ' + sheetName);
  var added = 0;
  outputs.forEach(function (o) {
    sh.appendRow([o.suggested_currency]);
    var lastRow = sh.getLastRow();
    if (costCol >= 1 && o.unit_cost_usd != null && !isNaN(Number(o.unit_cost_usd))) {
      sh.getRange(lastRow, costCol).setValue(Number(o.unit_cost_usd));
    }
    if (rawCol >= 1 && rawRequestText) {
      sh.getRange(lastRow, rawCol).setValue(rawRequestText);
    }
    if (compUrlCol >= 1 && compositionRawUrl) {
      sh.getRange(lastRow, compUrlCol).setValue(compositionRawUrl);
    }
    added++;
  });
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var lastCol = Math.max(
      sh.getLastColumn(),
      costCol >= 1 ? costCol : 1,
      rawCol >= 1 ? rawCol : 1,
      compUrlCol >= 1 ? compUrlCol : 1,
      1
    );
    sh.getRange(2, 1, lastRow - 1, lastCol).sort({ column: 1, ascending: true });
  }
  return added;
}

function readCurrencyStringsFromSheet_(ss, sheetName) {
  var sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('Missing sheet: ' + sheetName);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  var out = [];
  var seen = {};
  for (var i = 0; i < vals.length; i++) {
    var c = vals[i][0];
    if (c == null) continue;
    var s = String(c).trim();
    if (!s || seen[s]) continue;
    seen[s] = true;
    out.push(s);
  }
  out.sort(function (a, b) { return a.localeCompare(b); });
  return out;
}

function getGitHubTarget_() {
  return {
    owner: getProp_(SCRIPT_PROP_GH_OWNER, 'TrueSightDAO'),
    repo: getProp_(SCRIPT_PROP_GH_REPO, 'agroverse-inventory'),
    branch: getProp_(SCRIPT_PROP_GH_BRANCH, 'main'),
    path: getProp_(SCRIPT_PROP_GH_PATH, DEFAULT_GH_PATH),
  };
}

function getCompositionsDir_() {
  var d = getProp_(SCRIPT_PROP_COMPOSITIONS_DIR, DEFAULT_COMPOSITIONS_DIR).replace(/\/+$/, '');
  return d || DEFAULT_COMPOSITIONS_DIR;
}

function compositionFilePath_(requestId) {
  var safe = String(requestId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe) safe = Utilities.getUuid();
  return getCompositionsDir_() + '/' + safe + '.json';
}

/** Strip large base64 from the payload we log to Sheets. */
function sanitizePayloadForSheets_(data) {
  var clone;
  try { clone = JSON.parse(JSON.stringify(data)); } catch (e) { return data; }
  if (clone.conversion_proof && clone.conversion_proof.data_base64) {
    clone.conversion_proof = {
      filename: clone.conversion_proof.filename || null,
      mime_type: clone.conversion_proof.mime_type || null,
      note: 'body_stored_in_github_currency_compositions_json_only',
    };
  }
  return clone;
}

function buildCanonicalComposition_(data, requestId, serverGeneratedAtIso) {
  var c = (data.composition && typeof data.composition === 'object') ? data.composition : {};
  var inputs = Array.isArray(data.inputs) ? data.inputs : (Array.isArray(c.inputs) ? c.inputs : []);
  var outputs = Array.isArray(data.outputs) ? data.outputs : (Array.isArray(c.outputs) ? c.outputs : []);
  var totals = (data.totals && typeof data.totals === 'object')
    ? data.totals
    : (c.totals && typeof c.totals === 'object' ? c.totals : {});
  var holder = (c.holder && typeof c.holder === 'object')
    ? c.holder
    : { key: data.holder_key || null, label: data.holder_label || null };
  var pow = null;
  var pr = data.conversion_proof;
  if (pr && typeof pr === 'object' && pr.data_base64) {
    pow = {
      filename: pr.filename || 'proof',
      mime_type: pr.mime_type || 'application/octet-stream',
      data_base64: String(pr.data_base64),
    };
  }
  var out = {
    schema_version: c.schema_version != null ? Number(c.schema_version) : 2,
    request_id: requestId,
    generated_at: serverGeneratedAtIso,
    source: 'repackaging_currency_ingest',
    event: String(data.event || 'repackaging_batch_creation'),
    holder: holder,
    inputs: inputs,
    outputs: outputs,
    totals: totals,
    raw_request_text: data.raw_request_text || null,
    client: { client_generated_at: c.client_generated_at || data.client_generated_at || null },
  };
  if (pow) out.proof_of_work = pow;
  return out;
}

function encodePathSegments_(relativePath) {
  return String(relativePath || '')
    .split('/')
    .filter(function (s) { return s.length > 0; })
    .map(function (seg) { return encodeURIComponent(seg); })
    .join('/');
}

/** PUT arbitrary JSON file to repo root-relative path. */
function putGitHubJsonAtPath_(relativePath, commitMessage, jsonObj) {
  var pat = getPat_();
  if (!pat) return { ok: false, message: 'PAT missing' };
  var owner = getProp_(SCRIPT_PROP_GH_OWNER, 'TrueSightDAO');
  var repo = getProp_(SCRIPT_PROP_GH_REPO, 'agroverse-inventory');
  var branch = getProp_(SCRIPT_PROP_GH_BRANCH, 'main');

  var jsonString = JSON.stringify(jsonObj, null, 2);
  var encoded = Utilities.base64Encode(jsonString, Utilities.Charset.UTF_8);
  var pathEncoded = encodePathSegments_(relativePath);
  var apiBase = 'https://api.github.com/repos/' +
    encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/' + pathEncoded;
  var getUrl = apiBase + '?ref=' + encodeURIComponent(branch);

  var headers = {
    Authorization: 'Bearer ' + pat,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  var existingSha = null;
  var getResp = UrlFetchApp.fetch(getUrl, { method: 'get', headers: headers, muteHttpExceptions: true });
  if (getResp.getResponseCode() === 200) {
    var parsed = JSON.parse(getResp.getContentText());
    existingSha = parsed && parsed.sha ? parsed.sha : null;
  } else if (getResp.getResponseCode() !== 404) {
    return {
      ok: false,
      message: 'GitHub GET failed: HTTP ' + getResp.getResponseCode() + ' ' + getResp.getContentText().slice(0, 400),
    };
  }

  var putBody = { message: commitMessage, content: encoded, branch: branch };
  if (existingSha) putBody.sha = existingSha;

  var putResp = UrlFetchApp.fetch(apiBase, {
    method: 'put',
    headers: headers,
    payload: JSON.stringify(putBody),
    muteHttpExceptions: true,
  });
  if (putResp.getResponseCode() !== 200 && putResp.getResponseCode() !== 201) {
    return {
      ok: false,
      message: 'GitHub PUT failed: HTTP ' + putResp.getResponseCode() + ' ' + putResp.getContentText().slice(0, 400),
    };
  }
  var putJson = JSON.parse(putResp.getContentText());
  return { ok: true, message: 'committed', sha: putJson && putJson.content ? putJson.content.sha : undefined };
}

function publishCurrenciesJsonToGitHub_(currencyList) {
  var t = getGitHubTarget_();
  var payloadObj = {
    generatedAt: new Date().toISOString(),
    source: 'repackaging_currency_ingest',
    currencies: currencyList || [],
  };
  var r = putGitHubJsonAtPath_(t.path, 'chore(inventory): refresh currencies.json (repackaging ingest)', payloadObj);
  if (!r.ok && r.message === 'PAT missing') {
    return {
      ok: false,
      message: 'PAT missing: set AGROVERSE_INVENTORY_CURRENCIES_PAT (or AGROVERSE_INVENTORY_GIT_REPO_UPDATE_PAT)',
    };
  }
  return r;
}
