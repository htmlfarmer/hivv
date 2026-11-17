// api/lib/node-privacy.js — explicit public/private node profiles.
//
// THE PROBLEM
// ───────────
// The public node API returned EVERYTHING: raw LAN IP, public IP, full
// hardware, system details, precise coordinates, ASN, ISP. A person donating
// their idle GPU did not sign up for a public inventory of their home
// network's address space.
//
// THE FIX
// ───────
// Every bee carries a `visibility` setting with three tiers:
//
//   public  → name, models, status, coarse COUNTRY only
//   network → + region, ASN, network class, rounded coordinates
//   private → + hardware and performance, but NO addresses at all
//
//   default → `network`
//
// The tier is the BEE'S choice, set at registration and changeable by the
// bee. The hub never widens it. A `private` bee still shows up in the
// leaderboard (people deserve credit for their contribution) — it just does
// not publish where it is or what its address is.
//
// A fourth, internal-only tier exists for the operator's own views:
//   operator → everything, never published publicly.

const crypto = require('crypto');

const VISIBILITY_TIERS = ['public', 'network', 'private'];
const DEFAULT_VISIBILITY = 'network';

// The fields a `private` bee never publishes, at any tier below `operator`.
const NEVER_PUBLIC = [
    'ip', 'lan_ip', 'public_ip', 'public_ip_hash',
    'latitude', 'longitude', 'exact_coordinates',
    'host', 'hostname', 'mac', 'serial',
];

// Coordinates are rounded to ~1.1 km — a map dot, never a house.
function roundCoord(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

function normalizeVisibility(value) {
    const v = String(value || '').toLowerCase().trim();
    return VISIBILITY_TIERS.includes(v) ? v : DEFAULT_VISIBILITY;
}

// A coarse country from whatever location data the bee reported.
function coarseCountry(loc) {
    if (!loc || typeof loc !== 'object') return null;
    const cc = loc.country_code || loc.countryCode;
    if (cc) return String(cc).toUpperCase().slice(0, 8);
    const country = loc.country;
    return country ? String(country).slice(0, 64) : null;
}

// The country name is only useful if it is a COUNTRY — a city name would
// narrow the location far too much for the `public` tier.
function countryName(loc) {
    if (!loc || typeof loc !== 'object') return null;
    const c = loc.country;
    return c ? String(c).slice(0, 64) : null;
}

/**
 * Project a node for a given audience.
 *
 * @param {object} node        the raw node object
 * @param {object} opts
 * @param {string} opts.view   'public' | 'partner' | 'operator'
 * @param {string} [opts.visibility] the bee's tier (defaults from node.visibility)
 * @returns {object} the projected node
 */
function projectNode(node, { view = 'public', visibility } = {}) {
    if (!node) return null;
    const tier = normalizeVisibility(visibility || node.visibility || DEFAULT_VISIBILITY);

    // The operator sees everything. This view never leaves the admin API.
    if (view === 'operator') {
        return { ...node, visibility: tier };
    }

    const loc = node.location || {};
    const base = {
        id: node.node_id,
        bee_id: node.node_id,
        name: node.name,
        status: node.status,
        version: node.version,
        registered_at: node.registered_at,
        last_heartbeat: node.last_heartbeat,
        heartbeat_age_s: node.last_heartbeat
            ? Math.round((Date.now() - node.last_heartbeat) / 1000) : null,
        capabilities: (node.capabilities || []).slice(0, 8),
        local_models: (node.local_models || []).map((m) => ({
            provider: m.provider || null,
            model: m.model || m.name || null,
            loaded: m.loaded !== false,
            locked: m.locked === true,
        })),
        volunteer: node.volunteer === true || node.volunteer?.on === true,
        visibility: tier,
    };

    // ── public tier: location is COUNTRY only ─────────────────────────
    const publicLocation = { country_code: coarseCountry(loc) };
    if (tier !== 'public') {
        publicLocation.country = countryName(loc);
        publicLocation.region = loc.region || null;
        publicLocation.asn = loc.asn || null;
        publicLocation.network_class = loc.network_class || 'unknown';
        publicLocation.latitude = roundCoord(loc.lat);
        publicLocation.longitude = roundCoord(loc.lon ?? loc.lng);
    } else {
        // The `public` tier deliberately does NOT carry the country NAME —
        // some countries are small enough that the name narrows the location
        // as much as a city would.
        publicLocation.country = null;
        publicLocation.region = null;
        publicLocation.asn = null;
        publicLocation.network_class = loc.network_class || 'unknown';
        publicLocation.latitude = null;
        publicLocation.longitude = null;
    }

    // ── hardware + performance: `private` tier only ──────────────────
    if (tier === 'private') {
        base.system = {
            cpus: node.system?.cpus ?? null,
            arch: node.system?.arch ?? null,
            platform: node.system?.platform ?? null,
            cpu_freq_mhz: node.metrics?.cpu_freq_mhz || node.system?.cpu_freq_mhz || 0,
        };
        base.gpus = node.gpus || node.metrics?.gpus || [];
        base.cpu_model = node.cpu_model || '';
        base.metrics = {
            cpu_percent: node.total_cpu_percent || 0,
            mem_percent: node.total_mem_percent || 0,
            mem_total_mb: node.metrics?.mem_total_mb || 0,
            mem_used_mb: node.metrics?.mem_used_mb || 0,
            active_jobs: node.active_tasks || 0,
            workers: node.max_concurrent_jobs || 0,
            uptime_seconds: node.uptime_seconds || 0,
            available_capacity: (node.max_concurrent_jobs || 0) - (node.active_tasks || 0),
        };
        base.stats = {
            tasks_completed: node.tasks_completed || 0,
            tasks_failed: node.tasks_failed || 0,
            total_tokens_processed: node.total_tokens_processed || 0,
            total_cost: node.total_cost || 0,
            tokens_per_sec: node.tokens_per_sec || 0,
        };
        base.tools = node.tools || [];
        base.tools_port = node.tools_port || 0;
        base.work_status = node.work_status || '';
        base.current_problem_id = node.current_problem_id || null;
    }

    base.location = publicLocation;

    // ── addresses: NEVER at the `private` tier, never publicly ───────
    // A `network` bee publishes its NETWORK identity (asn/region) but not the
    // address that reaches it. The LAN IP in particular is a map of somebody's
    // home network and has no business being public.
    if (tier === 'network') {
        base.ip = null;
        base.lan_ip = null;
        base.public_ip = null;
    }

    return base;
}

// The peer-facing data a node needs to REACH another node. This is separate
// from the public view: a node that serves inference genuinely needs the
// address, but it is exchanged between nodes, not published on the website.
function projectForPeer(node) {
    if (!node) return null;
    return {
        id: node.node_id,
        name: node.name,
        ip: node.ip || node.lan_ip || null,
        lan_ip: node.lan_ip || null,
        port: node.tools_port || 0,
        models: (node.local_models || []).map((m) => m.model || m.name).filter(Boolean),
    };
}

module.exports = {
    VISIBILITY_TIERS,
    DEFAULT_VISIBILITY,
    NEVER_PUBLIC,
    normalizeVisibility,
    coarseCountry,
    roundCoord,
    projectNode,
    projectForPeer,
};
