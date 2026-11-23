// api/lib/memory.js — "remember useful information between interactions".
//
// WHAT THIS IS
// ────────────
// A tiny, per-principal key/value store. A model asks to remember
// ("remember that the user prefers metric units") and can recall it later
// ("what do you remember about me?"). Scoped by principal, so one member's
// memory is never visible to another.
//
// STORAGE
// ───────
//   • with a database → the hivv_memory table (migration 022)
//   • without one (local/offline install) → a JSON file under
//     $HIVV_DATA_DIR/memory/, one file per principal
//
// The value is stored as JSONB, so a model can remember structured things
// (a list, an object, a number) — not just strings.
//
// PRIVACY
// ───────
// Memory is scoped by the SAME principal the policy gate uses
// (`user:<id>` for a signed-in member, a visitor id otherwise). Recall is
// always filtered by that principal — there is no "read anyone's memory"
// path, and the SQL has no way to express one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pool = null;
let dataDir = null;

const MAX_KEY_LEN = 120;
const MAX_VALUE_BYTES = 32 * 1024;      // 32 KB per memory
const DEFAULT_LIMIT = 25;

function init(pgPool, opts = {}) {
    pool = pgPool || null;
    if (opts.dataDir) dataDir = opts.dataDir;
    if (!dataDir) {
        try {
            const lm = require('./local-mode');
            dataDir = lm.dataDir ? lm.dataDir() : null;
        } catch (_e) { dataDir = null; }
    }
    if (!pool) {
        console.warn('[MEMORY] no database — using file-backed memory in ' + (dataDir || '(no data dir)'));
    }
}

// ── local-mode file store ───────────────────────────────────────────────────

function _memoryDir() {
    if (!dataDir) return null;
    const dir = path.join(dataDir, 'memory');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { void _e; }
    return dir;
}

function _fileFor(principal) {
    const dir = _memoryDir();
    if (!dir) return null;
    const h = crypto.createHash('sha256').update(String(principal || 'anon')).digest('hex').slice(0, 32);
    return path.join(dir, `${h}.json`);
}

function _readLocal(principal) {
    const f = _fileFor(principal);
    if (!f) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
        return (raw && typeof raw === 'object') ? raw : {};
    } catch (_e) {
        return {};
    }
}

function _writeLocal(principal, data) {
    const f = _fileFor(principal);
    if (!f) return false;
    try {
        const tmp = `${f}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, f);
        return true;
    } catch (e) {
        console.warn('[MEMORY] local write failed:', e.message);
        return false;
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _key(k) {
    const s = String(k == null ? '' : k).trim().replace(/\s+/g, ' ');
    if (!s) return null;
    return s.slice(0, MAX_KEY_LEN);
}

function _nowIso() { return new Date().toISOString(); }

function _shape(row) {
    return {
        key: row.key,
        value: row.value,
        tags: row.tags || [],
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at || null,
    };
}

// ── API ─────────────────────────────────────────────────────────────────────

/**
 * Store (or overwrite) one memory.
 * @returns {{ok:true, key:string, created:boolean}|{ok:false, error:string}}
 */
async function remember(principal, key, value, { tags = [], ttlSeconds = null } = {}) {
    const p = String(principal || 'anon');
    const k = _key(key);
    if (!k) return { ok: false, error: 'a memory key is required' };
    let payload;
    try {
        payload = JSON.stringify(value === undefined ? null : value);
    } catch (_e) {
        return { ok: false, error: 'memory value must be JSON-serializable' };
    }
    if (Buffer.byteLength(payload) > MAX_VALUE_BYTES) {
        return { ok: false, error: `memory value too large (>${MAX_VALUE_BYTES} bytes)` };
    }
    const tagList = Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 40)).slice(0, 12) : [];
    const expires = ttlSeconds ? new Date(Date.now() + Math.max(60, parseInt(ttlSeconds) || 60) * 1000).toISOString() : null;

    if (pool) {
        try {
            const r = await pool.query(
                `INSERT INTO hivv_memory (principal, key, value, tags, expires_at)
                 VALUES ($1, $2, $3::jsonb, $4, $5)
                 ON CONFLICT (principal, key)
                 DO UPDATE SET value = EXCLUDED.value,
                               tags = EXCLUDED.tags,
                               expires_at = EXCLUDED.expires_at,
                               updated_at = NOW()
                 RETURNING (xmax = 0) AS inserted, key, value, tags, created_at, updated_at, expires_at`,
                [p, k, payload, tagList, expires]);
            const row = r.rows[0] || {};
            return { ok: true, key: row.key || k, created: row.inserted === true, memory: _shape(row) };
        } catch (e) {
            console.warn('[MEMORY] db write failed:', e.message);
            return { ok: false, error: `could not store memory: ${e.message}` };
        }
    }

    const all = _readLocal(p);
    const existed = Object.prototype.hasOwnProperty.call(all, k);
    all[k] = { value: value === undefined ? null : value, tags: tagList, created_at: all[k]?.created_at || _nowIso(), updated_at: _nowIso(), expires_at: expires };
    if (!_writeLocal(p, all)) return { ok: false, error: 'could not write memory (no data directory)' };
    return { ok: true, key: k, created: !existed, memory: _shape(all[k]) };
}

/**
 * Recall memories for a principal.
 * @param {object} opts  { query?, tag?, limit? }
 */
async function recall(principal, { query = null, tag = null, limit = DEFAULT_LIMIT } = {}) {
    const p = String(principal || 'anon');
    const lim = Math.max(1, Math.min(parseInt(limit) || DEFAULT_LIMIT, 200));
    let items = [];

    if (pool) {
        try {
            const params = [p];
            let where = 'principal = $1';
            if (query) {
                params.push(`%${String(query).toLowerCase()}%`);
                where += ` AND (LOWER(key) LIKE $${params.length} OR LOWER(COALESCE(value::text,'')) LIKE $${params.length})`;
            }
            if (tag) {
                params.push(String(tag));
                where += ` AND $${params.length} = ANY(tags)`;
            }
            params.push(lim);
            const r = await pool.query(
                `SELECT key, value, tags, created_at, updated_at, expires_at
                   FROM hivv_memory
                  WHERE ${where} AND (expires_at IS NULL OR expires_at > NOW())
                  ORDER BY updated_at DESC
                  LIMIT $${params.length}`, params);
            items = r.rows.map(_shape);
        } catch (e) {
            console.warn('[MEMORY] db read failed:', e.message);
            return { ok: false, error: `could not read memory: ${e.message}` };
        }
    } else {
        const all = _readLocal(p);
        const now = Date.now();
        for (const [k, v] of Object.entries(all)) {
            if (v && v.expires_at && Date.parse(v.expires_at) <= now) continue;
            if (query) {
                const needle = String(query).toLowerCase();
                const hay = `${k} ${JSON.stringify(v.value || '')}`.toLowerCase();
                if (!hay.includes(needle)) continue;
            }
            if (tag && !(v.tags || []).includes(String(tag))) continue;
            items.push(_shape({ key: k, ...v }));
        }
        items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
        items = items.slice(0, lim);
    }

    return { ok: true, count: items.length, items };
}

/**
 * Forget one memory (or everything, when no key is given).
 */
async function forget(principal, key = null) {
    const p = String(principal || 'anon');
    if (pool) {
        try {
            const k = _key(key);
            if (!k) {
                const r = await pool.query('DELETE FROM hivv_memory WHERE principal = $1 RETURNING key', [p]);
                return { ok: true, removed: r.rowCount || 0, scope: 'all' };
            }
            const r = await pool.query('DELETE FROM hivv_memory WHERE principal = $1 AND key = $2 RETURNING key', [p, k]);
            return { ok: true, removed: r.rowCount || 0, scope: 'key', key: k };
        } catch (e) {
            console.warn('[MEMORY] db delete failed:', e.message);
            return { ok: false, error: `could not forget: ${e.message}` };
        }
    }
    const all = _readLocal(p);
    if (!key) {
        const n = Object.keys(all).length;
        _writeLocal(p, {});
        return { ok: true, removed: n, scope: 'all' };
    }
    const k = _key(key);
    const existed = Object.prototype.hasOwnProperty.call(all, k);
    if (existed) { delete all[k]; _writeLocal(p, all); }
    return { ok: true, removed: existed ? 1 : 0, scope: 'key', key: k };
}

module.exports = { init, remember, recall, forget, MAX_KEY_LEN, MAX_VALUE_BYTES };
