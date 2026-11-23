// api/lib/textparse.js — deterministic text → structure.
//
// WHY HAND-ROLLED
// ───────────────
// The obvious move was `npm i js-yaml fast-xml-parser`. We did not, because
// every dependency is supply-chain surface on a box that hands out API keys
// and runs code. These four parsers are small, bounded, and have no
// prototype-pollution footguns (they build plain objects with a null
// prototype when the key is "__proto__").
//
// Exports:
//   stripHtml(html)        → readable text (blocks become newlines)
//   decodeEntities(s)      → &amp; → &, &#39; → ' …
//   parseXml(xml)          → nested plain objects
//   parseYaml(yaml)        → plain objects (a practical subset)
//   detectFormat(text)     → 'json' | 'csv' | 'xml' | 'yaml' | 'text'
//   extractEntities(text)  → urls / emails / dates / numbers

// ── HTML ────────────────────────────────────────────────────────────────────

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”', bull: '•', middot: '·', times: '×', divide: '÷',
    copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', deg: '°',
    laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', agrave: 'à',
    uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ',
};

function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, ent) => {
        if (ent[0] === '#') {
            const code = ent[1] === 'x' || ent[1] === 'X'
                ? parseInt(ent.slice(2), 16)
                : parseInt(ent.slice(1), 10);
            if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
            try { return String.fromCodePoint(code); } catch (_e) { return m; }
        }
        const lower = ent.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, lower) ? ENTITIES[lower] : m;
    });
}

/**
 * Turn an HTML document into readable text.
 * Script/style content is dropped entirely; block-level tags become
 * newlines so paragraphs do not run together.
 */
function stripHtml(html) {
    let s = String(html == null ? '' : html);
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|figure|main|aside|nav)\s*>/gi, '\n');
    s = s.replace(/<(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|figure|main|aside|nav)\b[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    s = s.replace(/[ \t\f\v]+/g, ' ');
    s = s.replace(/ *\n */g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
}

/** The readable <title> of an HTML document, if any. */
function htmlTitle(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html || ''));
    return m ? decodeEntities(m[1]).trim() : null;
}

// ── XML ─────────────────────────────────────────────────────────────────────
// A small, forgiving XML reader: elements, attributes, text, CDATA,
// comments. Namespaces are dropped (we keep the local name). It is not a
// validating parser — it is a structure extractor.

function parseXml(xml) {
    const src = String(xml == null ? '' : xml);
    let i = 0;
    const stack = [];
    let root = null;

    const skipTo = (needle) => {
        const at = src.indexOf(needle, i);
        i = at === -1 ? src.length : at + needle.length;
    };

    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt === -1) break;
        // text content between tags
        if (lt > i && stack.length) {
            const text = src.slice(i, lt);
            if (text.trim()) {
                const node = stack[stack.length - 1];
                const decoded = decodeEntities(text).trim();
                if (node.text) node.text += ' ' + decoded;
                else node.text = decoded;
            }
        }
        i = lt;
        if (src.startsWith('<!--', i)) { skipTo('-->'); continue; }
        if (src.startsWith('<![CDATA[', i)) {
            const end = src.indexOf(']]>', i);
            const chunk = src.slice(i + 9, end === -1 ? src.length : end);
            if (stack.length) {
                const node = stack[stack.length - 1];
                node.text = node.text ? `${node.text}${chunk}` : chunk;
            }
            i = end === -1 ? src.length : end + 3;
            continue;
        }
        if (src.startsWith('<?', i)) { skipTo('?>'); continue; }
        if (src.startsWith('<!', i)) { skipTo('>'); continue; }
        // closing tag
        if (src.startsWith('</', i)) {
            const end = src.indexOf('>', i);
            i = end === -1 ? src.length : end + 1;
            stack.pop();
            continue;
        }
        // opening tag
        const end = src.indexOf('>', i);
        if (end === -1) break;
        const raw = src.slice(i + 1, end);
        const selfClosing = /\/\s*$/.test(raw);
        const body = raw.replace(/\/\s*$/, '');
        const nameMatch = /^([^\s/>]+)/.exec(body);
        if (!nameMatch) { i = end + 1; continue; }
        const name = nameMatch[1].replace(/^.*:/, '');   // drop the namespace prefix
        const attrs = {};
        const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
        let am;
        const attrBody = body.slice(nameMatch[1].length);
        while ((am = attrRe.exec(attrBody)) !== null) {
            const key = am[1].replace(/^.*:/, '');
            const val = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : am[5] || '';
            attrs[key] = decodeEntities(val);
        }
        const node = { name, attrs, children: [], text: '' };
        if (stack.length) stack[stack.length - 1].children.push(node);
        else if (!root) root = node;
        if (!selfClosing) stack.push(node);
        i = end + 1;
    }

    // JSON-ish shape: attributes and children collapse onto the object.
    // A leaf with only text becomes that text (so <title>T</title> → "T"),
    // which is what every JSON/XML bridge does.
    const toPlain = (node) => {
        const out = Object.create(null);
        for (const [k, v] of Object.entries(node.attrs)) out[`@${k}`] = v;
        const kids = node.children;
        const text = node.text || '';
        if (!kids.length) {
            if (!text) return out;               // empty element → {}
            if (!Object.keys(out).length) return text;   // pure text leaf → the string
            out['#text'] = text;
            return out;
        }
        const byName = new Map();
        for (const k of kids) {
            const p = toPlain(k);
            if (!byName.has(k.name)) byName.set(k.name, []);
            byName.get(k.name).push(p);
        }
        for (const [k, list] of byName) {
            out[k] = list.length === 1 ? list[0] : list;
        }
        if (text) out['#text'] = text;
        return out;
    };

    if (!root) return null;
    const plain = toPlain(root);
    const result = Object.create(null);
    for (const [k, v] of Object.entries(plain)) result[k] = v;
    return result;
}

// ── YAML (a practical subset) ───────────────────────────────────────────────
// Supports: nested maps by indentation, block sequences (`- `), inline
// flow maps/sequences, quoted and bare scalars, comments, `null`/`true`/
// `false`/numbers. NOT supported: anchors, aliases, multi-document streams,
// block scalars (`|`/`>`) — those come through as plain strings.

function _yamlScalar(raw) {
    const s = String(raw).trim();
    if (s === '' || s === '~' || s.toLowerCase() === 'null') return null;
    if (s === 'true' || s.toLowerCase() === 'yes' || s.toLowerCase() === 'on') return true;
    if (s === 'false' || s.toLowerCase() === 'no' || s.toLowerCase() === 'off') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
    if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
        (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
        return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, '\n');
    }
    if (s.startsWith('[') && s.endsWith(']')) {
        const inner = s.slice(1, -1).trim();
        if (!inner) return [];
        return splitFlow(inner).map((p) => _yamlScalar(p));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
        const inner = s.slice(1, -1).trim();
        const out = Object.create(null);
        if (!inner) return out;
        for (const part of splitFlow(inner)) {
            const idx = part.indexOf(':');
            if (idx === -1) continue;
            out[part.slice(0, idx).trim()] = _yamlScalar(part.slice(idx + 1));
        }
        return out;
    }
    return s;
}

function splitFlow(s) {
    const parts = [];
    let depth = 0, quote = null, cur = '';
    for (const c of s) {
        if (quote) {
            cur += c;
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === '[' || c === '{') depth++;
        if (c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p) => p.trim());
}

function parseYaml(yaml) {
    const lines = String(yaml == null ? '' : yaml)
        .split(/\r?\n/)
        .map((l) => l.replace(/\t/g, '    '))
        .filter((l) => l.trim() !== '' && !/^\s*#/.test(l));

    let pos = 0;

    function indentOf(line) { return line.length - line.trimStart().length; }

    function parseBlock(minIndent) {
        if (pos >= lines.length) return null;
        const first = lines[pos];
        const ind = indentOf(first);
        if (ind < minIndent) return null;
        if (first.trim().startsWith('- ') || first.trim() === '-') {
            const arr = [];
            while (pos < lines.length) {
                const line = lines[pos];
                const li = indentOf(line);
                if (li < ind) break;
                const t = line.trim();
                if (!(t.startsWith('- ') || t === '-')) break;
                const rest = t === '-' ? '' : t.slice(2).trim();
                pos++;
                if (!rest) {
                    const child = parseBlock(ind + 1);
                    arr.push(child === null ? null : child);
                } else if (/^[^:#]+:(\s|$)/.test(rest) && !rest.startsWith('{') && !rest.startsWith('[')) {
                    // "- key: value" — an inline map that may continue
                    const inlineIndent = ind + 2;
                    const synthetic = lines.slice(pos);
                    lines.splice(pos, 0, ' '.repeat(inlineIndent) + rest);
                    const child = parseBlock(inlineIndent);
                    lines.splice(pos, 1);
                    void synthetic;
                    arr.push(child);
                } else {
                    arr.push(_yamlScalar(rest));
                }
            }
            return arr;
        }
        const map = Object.create(null);
        while (pos < lines.length) {
            const line = lines[pos];
            const li = indentOf(line);
            if (li < ind) break;
            if (li > ind) { pos++; continue; }   // stray deeper line — skip
            const t = line.trim();
            const colon = findColon(t);
            if (colon === -1) { pos++; continue; }
            const key = t.slice(0, colon).trim().replace(/^["']|["']$/g, '');
            const rest = t.slice(colon + 1).trim();
            pos++;
            if (rest !== '' && !rest.startsWith('#')) {
                map[key] = _yamlScalar(rest);
            } else {
                const child = parseBlock(ind + 1);
                map[key] = child === null ? null : child;
            }
        }
        return map;
    }

    // a colon that is NOT inside quotes and not part of a URL
    function findColon(t) {
        let quote = null;
        for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === ':' && (i + 1 === t.length || /\s/.test(t[i + 1]))) return i;
        }
        return -1;
    }

    const result = parseBlock(0);
    return result === null ? Object.create(null) : result;
}

// ── detection + extraction ──────────────────────────────────────────────────

function detectFormat(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return 'text';
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { JSON.parse(s); return 'json'; } catch (_e) { /* not json */ }
    }
    if (s.startsWith('<?xml') || (s.startsWith('<') && /<\/[\w:.-]+>\s*$/.test(s))) return 'xml';
    const firstLine = s.split(/\r?\n/)[0];
    if (/^[ \t]*[-\w."' ]+:(\s|$)/.test(firstLine) && !/^\s*[[{]/.test(s)) return 'yaml';
    const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length >= 2) {
        const commas = lines.slice(0, 5).filter((l) => l.includes(',')).length;
        const tabs = lines.slice(0, 5).filter((l) => l.includes('\t')).length;
        if (commas >= Math.max(2, Math.ceil(lines.length * 0.6))) return 'csv';
        if (tabs >= Math.max(2, Math.ceil(lines.length * 0.6))) return 'csv';
    }
    return 'text';
}

function extractEntities(text) {
    const s = String(text == null ? '' : text);
    const urls = [...new Set((s.match(/\bhttps?:\/\/[^\s"'<>()\[\]{}]+/gi) || []))];
    const emails = [...new Set((s.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) || []))];
    const dates = [...new Set((s.match(/\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g) || []))];
    // scan numbers on a copy with dates removed — otherwise "2026-11-22"
    // contributes the bogus numbers 2026, -11 and -22 to the sum.
    const withoutDates = s.replace(/\b(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g, ' ');
    const numbers = (withoutDates.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
    return {
        urls,
        emails,
        dates,
        numbers: { count: numbers.length, sum: numbers.reduce((a, b) => a + b, 0), min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null },
    };
}

module.exports = {
    stripHtml, htmlTitle, decodeEntities,
    parseXml, parseYaml,
    detectFormat, extractEntities,
};
