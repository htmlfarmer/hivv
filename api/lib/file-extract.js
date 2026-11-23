// api/lib/file-extract.js — one place that knows how to turn bytes into text.
//
// WHY A LIBRARY
// ─────────────
// api/routes/files-routes.js already knew how to pull text out of a PDF
// (pdf-parse), a DOCX (mammoth) and a plain text file. The toolkit's
// file_read / file_search tools need exactly the same thing, and they must
// not disagree with the upload path about what a "kind" is. So the
// knowledge moved here and files-routes.js now imports it.
//
// Nothing here touches the filesystem or the network — it is a pure
// bytes → text function, so it is trivially testable.

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

const MAX_TEXT_CHARS = 200000;

// ── lazy heavy parsers (only loaded on first use) ───────────────────────────
let _pdf = null;
function pdfParseLib() { if (!_pdf) { _pdf = require('pdf-parse'); } return _pdf; }
let _mammoth = null;
function mammothLib() { if (!_mammoth) { _mammoth = require('mammoth'); } return _mammoth; }

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

/** Classify a file into 'text' | 'pdf' | 'docx' | 'image' | 'binary'. */
function kindOf(ext, mime) {
    if (PDF_EXT.has(ext) || /pdf/i.test(mime)) return 'pdf';
    if (DOC_EXT.has(ext) || /wordprocessingml|msword/i.test(mime)) return 'docx';
    if (IMAGE_EXT.has(ext) || /^image\//i.test(mime)) return 'image';
    if (TEXT_EXT.has(ext) || /^text\//i.test(mime) || /(json|yaml|xml|javascript|typescript|csv)/i.test(mime)) return 'text';
    return 'binary';
}

/**
 * Extract readable text from a buffer.
 * @returns {{ text: string, truncated?: boolean, pages?: number, error?: string }}
 */
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

// ── CSV ─────────────────────────────────────────────────────────────────────
// RFC 4180-ish: quoted fields, escaped quotes, embedded newlines.
function parseCsv(text, delimiter) {
    const src = String(text == null ? '' : text);
    const delim = delimiter || (src.indexOf('\t') >= 0 && src.indexOf(',') < 0 ? '\t' : ',');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += c;
            continue;
        }
        if (c === '"') { inQuotes = true; continue; }
        if (c === delim) { row.push(field); field = ''; continue; }
        if (c === '\r') continue;
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

/** CSV → array of objects using the first row as the header. */
function csvToObjects(text, delimiter) {
    const rows = parseCsv(text, delimiter);
    if (!rows.length) return [];
    const header = rows[0].map((h) => String(h).trim());
    return rows.slice(1).map((r) => {
        const o = {};
        header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
        return o;
    });
}

module.exports = {
    TEXT_EXT, IMAGE_EXT, PDF_EXT, DOC_EXT, DANGEROUS_INLINE,
    MAX_TEXT_CHARS,
    extOf, safeName, kindOf, extractText,
    parseCsv, csvToObjects,
};
