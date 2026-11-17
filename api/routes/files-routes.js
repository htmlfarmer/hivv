// api/routes/files-routes.js — file uploads for the /chat UI.
//
// One endpoint accepts a single multipart file, classifies it, extracts text
// where it can (plain text/code, PDF via pdf-parse, DOCX via mammoth), stores
// the raw bytes on disk for a short TTL, and returns metadata the chat client
// uses to (a) inline text as prompt context, (b) preview/attach images for
// vision routing, or (c) just hold a generic attachment.
//
//   POST   /api/files/upload   multipart/form-data, field name "file"
//   GET    /api/files/:id      stream the stored bytes back (preview/download)
//   DELETE /api/files/:id      remove an upload early
//
// Security notes:
//  - Storage filenames are opaque random ids — the user's filename never touches
//    the path (no traversal). Original name is only used for Content-Disposition
//    and is sanitized.
//  - Uploads are served with nosniff + a locked-down CSP and, for anything that
//    could carry script (svg/html/xml), forced to download rather than inline.
//  - Size capped per file; a TTL sweep (startup + every 6h) prunes old uploads.
//  - The global /api/ rate limiter (per-IP) applies on top of this.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.HIVV_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads');
const MAX_MB = Math.max(1, parseInt(process.env.HIVV_UPLOAD_MAX_MB || '20', 10));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;   // cap on extracted text kept/returned for context
const TTL_MS = 1000 * 60 * 60 * (parseInt(process.env.HIVV_UPLOAD_TTL_H || '48', 10));

try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_e) { void _e; }

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BYTES, files: 1, fields: 8, fieldNameSize: 256 }
});

// ── lazy heavy parsers (only loaded on first use) ──────────────────────────
let _pdf = null;
function pdfParseLib() { if (!_pdf) { _pdf = require('pdf-parse'); } return _pdf; }
let _mammoth = null;
function mammothLib() { if (!_mammoth) { _mammoth = require('mammoth'); } return _mammoth; }

// ── classification ─────────────────────────────────────────────────────────
const TEXT_EXT = new Set([
    'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'log', 'json', 'jsonc', 'json5',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'html', 'htm', 'css',
    'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
    'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'cc', 'hpp',
    'cs', 'php', 'swift', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'sql', 'graphql', 'gql', 'pl', 'lua', 'r', 'scala', 'groovy', 'dart', 'ex', 'exs',
    'erl', 'hs', 'ml', 'nim', 'zig', 'asm', 's', 'tex', 'bib', 'diff', 'patch', 'makefile',
    'dockerfile', 'gitignore', 'editorconfig', 'properties'
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico', 'tiff']);
const PDF_EXT = new Set(['pdf']);
const DOC_EXT = new Set(['docx']);
// types that can carry active content — never render inline in a browser
const DANGEROUS_INLINE = new Set(['svg', 'html', 'htm', 'xml', 'xhtml', 'js', 'mjs']);

function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
    return m ? m[1].toLowerCase() : '';
}

function safeName(name) {
    return String(name || 'file')
        .replace(/[\x00-\x1f]/g, '') // eslint-disable-line no-control-regex
        .replace(/[/\\]/g, '_')
        .replace(/["']/g, '')
        .slice(0, 180) || 'file';
}

function kindOf(ext, mime) {
    if (PDF_EXT.has(ext) || /pdf/i.test(mime)) {return 'pdf';}
    if (DOC_EXT.has(ext) || /wordprocessingml|msword/i.test(mime)) {return 'docx';}
    if (IMAGE_EXT.has(ext) || /^image\//i.test(mime)) {return 'image';}
    if (TEXT_EXT.has(ext) || /^text\//i.test(mime) || /(json|yaml|xml|javascript|typescript|csv)/i.test(mime)) {return 'text';}
    return 'binary';
}

// ── text extraction ────────────────────────────────────────────────────────
async function extractText(kind, ext, buffer) {
    try {
        if (kind === 'text') {
            return { text: buffer.toString('utf8'), truncated: false };
        }
        if (kind === 'pdf') {
            const { PDFParse } = pdfParseLib();
            const parser = new PDFParse({ data: new Uint8Array(buffer) });
            try {
                const r = await parser.getText();
                return { text: String(r && r.text ? r.text : ''), truncated: false, pages: r && r.total };
            } finally { try { await parser.destroy(); } catch (_e) { void _e; } }
        }
        if (kind === 'docx') {
            const r = await mammothLib().extractRawText({ buffer });
            return { text: String(r && r.value ? r.value : ''), truncated: false };
        }
    } catch (e) {
        return { text: '', error: e.message };
    }
    return { text: '' };
}

// ── TTL sweep ──────────────────────────────────────────────────────────────
function sweep() {
    let removed = 0;
    try {
        const now = Date.now();
        for (const f of fs.readdirSync(UPLOAD_DIR)) {
            if (!f.endsWith('.json')) {continue;}
            const full = path.join(UPLOAD_DIR, f);
            try {
                const st = fs.statSync(full);
                if (now - st.mtimeMs > TTL_MS) {
                    const id = f.slice(0, -5);
                    for (const victim of [full, path.join(UPLOAD_DIR, id)]) {
                        try { fs.unlinkSync(victim); removed++; } catch (_e) { void _e; }
                    }
                }
            } catch (_e) { void _e; }
        }
    } catch (_e) { void _e; }
    if (removed) {console.log(`[FILES] swept ${removed} expired upload artifact(s)`);}
}
sweep();
const sweepTimer = setInterval(sweep, 1000 * 60 * 60 * 6);
if (sweepTimer.unref) {sweepTimer.unref();}

// ── POST /upload ───────────────────────────────────────────────────────────
router.post('/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            const tooBig = err.code === 'LIMIT_FILE_SIZE';
            return res.status(tooBig ? 413 : 400).json({
                error: tooBig ? `File too large (max ${MAX_MB}MB)` : `Upload failed: ${err.message}`
            });
        }
        if (!req.file) {return res.status(400).json({ error: 'No file provided (multipart field "file")' });}

        const { buffer, originalname, mimetype, size } = req.file;
        const ext = extOf(originalname);
        const kind = kindOf(ext, mimetype || '');
        const id = crypto.randomBytes(12).toString('hex');

        const extracted = await extractText(kind, ext, buffer);
        let text = extracted.text || '';
        let truncated = false;
        if (text.length > MAX_TEXT_CHARS) { text = text.slice(0, MAX_TEXT_CHARS); truncated = true; }

        const meta = {
            id,
            name: safeName(originalname),
            mime: mimetype || 'application/octet-stream',
            size,
            ext,
            kind,
            chars: text ? text.length : 0,
            truncated,
            text: text || undefined,     // persisted so GET can re-serve extracted text
            extract_error: extracted.error || undefined,
            pages: extracted.pages || undefined,
            uploaded_at: new Date().toISOString()
        };

        try {
            fs.writeFileSync(path.join(UPLOAD_DIR, id), buffer);            // opaque bytes
            fs.writeFileSync(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta));
        } catch (e) {
            return res.status(500).json({ error: `Could not store upload: ${e.message}` });
        }

        // Return everything the client needs; text is inlined into the prompt,
        // url is for previews/persistence, dataUrl for small images (vision).
        const out = {
            id: meta.id,
            name: meta.name,
            mime: meta.mime,
            size: meta.size,
            kind: meta.kind,
            ext: meta.ext,
            chars: meta.chars,
            truncated: meta.truncated,
            pages: meta.pages,
            extract_error: meta.extract_error,
            url: `/api/files/${meta.id}`,
            text: kind === 'text' || kind === 'pdf' || kind === 'docx' ? text : undefined
        };
        res.json(out);
    });
});

// ── GET /:id  (preview / download) ─────────────────────────────────────────
router.get('/:id', (req, res) => {
    const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
    if (!id) {return res.status(400).json({ error: 'bad id' });}
    const dataPath = path.join(UPLOAD_DIR, id);
    const metaPath = path.join(UPLOAD_DIR, `${id}.json`);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_e) { void _e; }
    if (!fs.existsSync(dataPath)) {return res.status(404).json({ error: 'not found (expired?)' });}

    const wantText = req.query.text === '1';
    if (wantText && meta.text !== null && meta.text !== undefined) {
        res.set('Content-Type', 'text/plain; charset=utf-8');
        return res.send(meta.text);
    }

    res.set('Content-Type', meta.mime || 'application/octet-stream');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    const inlineSafe = meta.kind === 'image' && !DANGEROUS_INLINE.has(meta.ext);
    const disp = inlineSafe ? 'inline' : 'attachment';
    res.set('Content-Disposition', `${disp}; filename="${safeName(meta.name).replace(/"/g, '')}"`);
    fs.createReadStream(dataPath).pipe(res);
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
    const id = String(req.params.id || '').replace(/[^a-f0-9]/gi, '');
    if (!id) {return res.status(400).json({ error: 'bad id' });}
    for (const p of [path.join(UPLOAD_DIR, id), path.join(UPLOAD_DIR, `${id}.json`)]) {
        try { fs.unlinkSync(p); } catch (_e) { void _e; }
    }
    res.json({ ok: true, id });
});

// ── GET /  (limits + health) ───────────────────────────────────────────────
router.get('/', (req, res) => {
    res.json({ ok: true, max_mb: MAX_MB, ttl_hours: Math.round(TTL_MS / 3600000), dir_writable: fs.existsSync(UPLOAD_DIR) });
});

module.exports = router;
