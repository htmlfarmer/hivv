// api/lib/file-store.js — the hub's document store (the upload shelf).
//
// The /api/files/upload endpoint already stored raw bytes on disk under an
// opaque random id, with extracted text alongside it in a .json sidecar and
// a 48h TTL. The toolkit's file_read / file_search tools need to read that
// same store — a model asked to "read the PDF I just uploaded" must reach
// exactly the bytes the upload endpoint took.
//
// SECURITY MODEL
// ──────────────
// A document is addressed by its opaque id ONLY. The user's filename never
// touches a path (no traversal, no absolute paths, no ".."). The id is
// sanitized to hex before it is used, so it cannot escape the directory.
// The hub never reads an arbitrary path from disk — there is no tool for
// that. Reading a bee's own disk is a BEE-side tool, sandboxed to an
// allow-listed root (see public_html/hivv-tools.py).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.HIVV_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const MAX_TEXT_CHARS = 200000;

try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_e) { void _e; }

function storeDir() { return UPLOAD_DIR; }

/** Ids are hex-only by construction — this strips anything else. */
function sanitizeId(id) {
    return String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
}

function metaPath(id) { return path.join(UPLOAD_DIR, `${id}.json`); }
function dataPath(id) { return path.join(UPLOAD_DIR, id); }

function readMeta(id) {
    const clean = sanitizeId(id);
    if (!clean) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath(clean), 'utf8'));
    } catch (_e) {
        return null;
    }
}

function readBytes(id) {
    const clean = sanitizeId(id);
    if (!clean) return null;
    try {
        return fs.readFileSync(dataPath(clean));
    } catch (_e) {
        return null;
    }
}

/**
 * Read one stored document.
 * @returns {{ok:true, document:object} | {ok:false, error:string}}
 */
function readDocument(id, { maxChars = MAX_TEXT_CHARS } = {}) {
    const clean = sanitizeId(id);
    if (!clean) return { ok: false, error: 'a document id is required' };
    const meta = readMeta(clean);
    if (!meta) return { ok: false, error: `no document with id '${clean}' (it may have expired — uploads live for 48h)` };
    const bytes = readBytes(clean);
    if (!bytes) return { ok: false, error: `document '${clean}' has no stored bytes (expired?)` };
    let text = typeof meta.text === 'string' ? meta.text : '';
    let truncated = !!meta.truncated;
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    return {
        ok: true,
        document: {
            id: clean,
            name: meta.name || clean,
            kind: meta.kind || 'binary',
            mime: meta.mime || 'application/octet-stream',
            ext: meta.ext || '',
            size: meta.size || bytes.length,
            pages: meta.pages || undefined,
            chars: text.length,
            truncated,
            extract_error: meta.extract_error || undefined,
            text,
        },
    };
}

/** Every document currently on the shelf (newest first). */
function listDocuments({ limit = 200 } = {}) {
    let names = [];
    try { names = fs.readdirSync(UPLOAD_DIR); } catch (_e) { return []; }
    const out = [];
    for (const f of names) {
        if (!f.endsWith('.json')) continue;
        const meta = readMeta(f.slice(0, -5));
        if (!meta) continue;
        out.push({
            id: meta.id,
            name: meta.name,
            kind: meta.kind,
            mime: meta.mime,
            size: meta.size,
            chars: meta.chars,
            pages: meta.pages,
            truncated: meta.truncated,
            uploaded_at: meta.uploaded_at,
        });
    }
    out.sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));
    return out.slice(0, Math.max(1, Math.min(parseInt(limit) || 200, 1000)));
}

/**
 * Search across every stored document.
 *
 * @param {object} opts
 * @param {string} opts.query      literal substring or regular expression
 * @param {boolean} opts.regex     treat the query as a regular expression
 * @param {boolean} opts.caseInsensitive
 * @param {number} opts.context     lines of context around a hit
 * @param {number} opts.maxResults  cap on hits per document
 * @param {string[]} opts.kinds     restrict to these document kinds
 */
function searchDocuments({ query, regex = false, caseInsensitive = true, context = 1, maxResults = 20, kinds = null } = {}) {
    const q = String(query == null ? '' : query);
    if (!q.trim()) return { ok: false, error: 'a search query is required' };
    let re = null;
    if (regex) {
        try {
            re = new RegExp(q, caseInsensitive ? 'gi' : 'g');
        } catch (e) {
            return { ok: false, error: `invalid regular expression: ${e.message}` };
        }
    }
    const docs = listDocuments({ limit: 500 });
    const results = [];
    const ctx = Math.max(0, Math.min(parseInt(context) || 0, 10));
    const cap = Math.max(1, Math.min(parseInt(maxResults) || 20, 200));

    for (const d of docs) {
        if (kinds && kinds.length && !kinds.includes(d.kind)) continue;
        const meta = readMeta(d.id);
        if (!meta || typeof meta.text !== 'string' || !meta.text) continue;
        const lines = meta.text.split(/\r?\n/);
        const hits = [];
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
            const line = lines[i];
            const found = re ? re.test(line) : (caseInsensitive ? line.toLowerCase().includes(q.toLowerCase()) : line.includes(q));
            if (re) re.lastIndex = 0;   // a global regex keeps state across .test()
            if (!found) continue;
            hits.push({
                line: i + 1,
                text: line.length > 400 ? line.slice(0, 400) + '…' : line,
                context: ctx ? lines.slice(Math.max(0, i - ctx), i).concat(lines.slice(i + 1, i + 1 + ctx)) : undefined,
            });
        }
        if (hits.length) {
            results.push({ id: d.id, name: d.name, kind: d.kind, hits, hit_count: hits.length });
        }
    }
    return {
        ok: true,
        query: q,
        regex,
        case_insensitive: caseInsensitive,
        documents_searched: docs.length,
        documents_matched: results.length,
        total_hits: results.reduce((n, r) => n + r.hit_count, 0),
        results,
    };
}

function newId() { return crypto.randomBytes(12).toString('hex'); }

module.exports = {
    UPLOAD_DIR, MAX_TEXT_CHARS,
    storeDir, sanitizeId, readMeta, readBytes, readDocument,
    listDocuments, searchDocuments, newId,
};
