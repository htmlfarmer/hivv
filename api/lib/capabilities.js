// api/lib/capabilities.js — §1 of HIVV_CAPABILITY_POLICY_PLAN.md.
// The universal noun list: a registry of capability keys with risk tiers and
// default policy verdicts, plus honest hive-side derivation of what each node
// can actually do (same discipline as honey — advertise only what we've seen).

let pool = null;
let registry = new Map();        // key -> {key,label,tier,default_verdict,requires_consent,description}
let registryAt = 0;
const REGISTRY_TTL_MS = 60000;

// tool name → capability (shared hivv-tools)
const TOOL_CAPS = {
  time: 'local.computation',
  calculate: 'local.computation',
  sysinfo: 'local.computation',
  search: 'web.search',
  news: 'web.search',
  fetch: 'web.fetch',
  'coding.execute': 'coding.execute',
  exec: 'coding.execute',
  shell: 'coding.execute',
  run: 'coding.execute',
  opencode: 'coding', // coder bee: node runs OpenCode headless (HIVV_OPENCODE_PLAN §4)
};

// hub-local services that exist as pm2 apps today
const HUB_SERVICES = [
  { key: 'speech.text-to-voice', via: 'hub (kokoro-tts)' },
  { key: 'speech.voice-to-text', via: 'hub (whisper-stt)' },
];

const VISION_RE = /(vision|-vl|vl-|llava|moondream|minicpm-v|qwen.*vl|pixtral|gemini)/i;

// Built-in capability list — used when there is no database (local/offline
// install). It mirrors the shipped registry so the partner manifest is
// meaningful on a fresh clone.
const BUILTIN_CAPABILITIES = [
  { key: 'reasoning', label: 'Reasoning', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'General language reasoning and chat' },
  { key: 'local.computation', label: 'Local computation', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Local CPU/math/time work' },
  { key: 'coding', label: 'Coding', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Code generation and editing' },
  { key: 'coding.execute', label: 'Execute code', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'Run code in a sandbox' },
  { key: 'web.search', label: 'Web search', tier: 'data', default_verdict: 'ask', requires_consent: true, description: 'Search the web' },
  { key: 'web.fetch', label: 'Fetch URL', tier: 'data', default_verdict: 'ask', requires_consent: true, description: 'Fetch a URL' },
  { key: 'speech.text-to-voice', label: 'Text to speech', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Synthesize speech' },
  { key: 'speech.voice-to-text', label: 'Speech to text', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Transcribe audio' },
  { key: 'vision', label: 'Vision', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Analyze images' },
];

async function loadRegistry(force = false) {
  if (!pool) return registry;
  if (!force && Date.now() - registryAt < REGISTRY_TTL_MS && registry.size) return registry;
  try {
    const r = await pool.query(
      'SELECT key, label, tier, description, default_verdict, requires_consent FROM hivv_capabilities WHERE active = TRUE');
    registry = new Map(r.rows.map(row => [row.key, row]));
    registryAt = Date.now();
  } catch (e) {
    console.warn('[CAPS] registry load failed:', e.message);
  }
  return registry;
}

function get(key) { return registry.get(key) || null; }

// longest-prefix registry lookup: 'web.fetch' matches; unknown 'foo.bar' → nearest parent or null
function resolve(key) {
  if (!key) return null;
  let k = String(key).toLowerCase();
  for (;;) {
    if (registry.has(k)) return registry.get(k);
    const i = k.lastIndexOf('.');
    if (i <= 0) return null;
    k = k.slice(0, i);
  }
}

// Known tools map to a registry capability. UNKNOWN tools must NOT default to
// the safe 'local.computation' (allow) tier — that would let any unmapped name
// (e.g. a node advertising 'coding.execute' or 'shell') slip past the gate. We
// return an unregistered 'tool.<name>' key; policy.gate() resolves that to null
// → tier 'side-effect' → verdict 'ask' (MAYBE), so a human must approve it.
function toolToCap(tool) { return TOOL_CAPS[tool] || `tool.${String(tool || 'unknown').toLowerCase()}`; }

// Honest derivation: what can this node do *right now*, per hub-observed truth?
function deriveNodeCaps(node) {
  const caps = new Set();
  const models = node.local_models || [];
  if (models.length) {
    caps.add('reasoning');
    caps.add('coding');
    caps.add('translation');
    if (models.some(m => VISION_RE.test(`${m.model || m.name || ''} ${m.provider || ''}`))) caps.add('vision');
  }
  for (const t of (node.tools || [])) caps.add(toolToCap(t));
  if (node.volunteer === true || node.volunteer?.on === true) caps.add('compute.donated'); // relay-tier spare cycles
  return [...caps];
}

// aggregate: capability -> { bees, online, nodes[] }
async function hiveSummary(orchestrator) {
  await loadRegistry();
  const out = {};
  for (const row of registry.values()) {
    out[row.key] = { ...row, bees: 0, online: 0, nodes: [] };
  }
  const ensure = (key) => {
    if (!out[key]) out[key] = { key, label: key, tier: 'compute', default_verdict: 'allow', requires_consent: false, bees: 0, online: 0, nodes: [] };
    return out[key];
  };
  for (const node of orchestrator.nodes.values()) {
    const caps = deriveNodeCaps(node);
    for (const c of caps) {
      const e = ensure(c);
      e.bees++;
      if (node.status !== 'offline') { e.online++; e.nodes.push(node.name || node.node_id); }
    }
  }
  // hub services count as always-online capacity
  for (const s of HUB_SERVICES) ensure(s.key).nodes.push(s.via);
  const tiers = {};
  for (const row of registry.values()) tiers[row.tier] = (tiers[row.tier] || 0) + 1;
  return { registry: Object.values(out), tiers, total: registry.size };
}

function init(pgPool) {
  pool = pgPool;
  if (!pool) {
    // LOCAL/OFFLINE MODE: no registry table to read. Seed the built-in list so
    // the partner surface still publishes a meaningful capability manifest
    // (the gate itself fails open to 'allow' for a single-user local gateway).
    for (const row of BUILTIN_CAPABILITIES) {
      if (!registry.has(row.key)) registry.set(row.key, row);
    }
    registryAt = Date.now();
    console.warn(`[CAPS] no database — using ${registry.size} built-in capabilities (local/offline mode)`);
    return;
  }
  loadRegistry().then(() => console.log(`[CAPS] registry loaded (${registry.size} capabilities)`));
}

function registryValues() { return [...registry.values()]; }

module.exports = { init, loadRegistry, get, resolve, toolToCap, deriveNodeCaps, hiveSummary, registryValues, TOOL_CAPS, HUB_SERVICES };
