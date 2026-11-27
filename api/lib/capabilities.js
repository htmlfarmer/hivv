// api/lib/capabilities.js — §1 of HIVV_CAPABILITY_POLICY_PLAN.md.
// The universal noun list: a registry of capability keys with risk tiers and
// default policy verdicts, plus honest hive-side derivation of what each node
// can actually do (same discipline as honey — advertise only what we've seen).

let pool = null;
let registry = new Map();        // key -> {key,label,tier,default_verdict,requires_consent,description}
let registryAt = 0;
const REGISTRY_TTL_MS = 60000;

// tool name → capability (shared hivv-tools)
// The toolkit (api/lib/toolkit.js) owns the canonical tool list; this table is
// the hub-side mirror so a tool called by ANY name — canonical, alias, or a
// name a bee invented — lands on the right capability. Unknown tools still
// fall through to `tool.<name>` → MAYBE (see toolToCap below).
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
  // ── the toolkit's twelve (canonical names) ──
  web_search: 'web.search',
  current_time: 'local.computation',
  calculator: 'local.computation',
  web_fetch: 'web.fetch',
  http_request: 'web.fetch',
  code_interpreter: 'coding.execute',
  file_read: 'data.file.read',
  file_search: 'data.file.read',
  memory: 'data.memory',
  text_parser: 'local.computation',
  timezone_convert: 'local.computation',
  translate: 'translation',
  // ── common aliases the models actually emit ──
  get_time: 'local.computation',
  now: 'local.computation',
  calc: 'local.computation',
  math: 'local.computation',
  reader: 'web.fetch',
  web_reader: 'web.fetch',
  read_url: 'web.fetch',
  request: 'web.fetch',
  curl: 'web.fetch',
  run_code: 'coding.execute',
  python: 'coding.execute',
  sandbox: 'coding.execute',
  read_file: 'data.file.read',
  read_document: 'data.file.read',
  open_file: 'data.file.read',
  search_files: 'data.file.read',
  grep: 'data.file.read',
  remember: 'data.memory',
  recall: 'data.memory',
  parse: 'local.computation',
  json_parse: 'local.computation',
  structure: 'local.computation',
  tz: 'local.computation',
  convert_time: 'local.computation',
  translation: 'translation',
};

// hub-local services that exist as pm2 apps today
const HUB_SERVICES = [
  { key: 'speech.text-to-voice', via: 'hub (kokoro-tts)' },
  { key: 'speech.voice-to-text', via: 'hub (whisper-stt)' },
];

const VISION_RE = /(vision|-vl|vl-|llava|moondream|minicpm-v|qwen.*vl|pixtral|gemini)/i;

// Built-in capability list — used when there is no database (local/offline
// install). It MIRRORS the shipped registry exactly. It used to drift from
// the seeded table (different tiers, six missing keys), which meant an
// offline install published a different capability surface than a live one.
const BUILTIN_CAPABILITIES = [
  { key: 'reasoning', label: 'Reasoning', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'General language reasoning and chat' },
  { key: 'vision', label: 'Vision', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Analyze images' },
  { key: 'speech.text-to-voice', label: 'Text to speech', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Synthesize speech' },
  { key: 'speech.voice-to-text', label: 'Speech to text', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Transcribe audio' },
  { key: 'translation', label: 'Translation', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Translate between languages' },
  { key: 'coding', label: 'Coding', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Generate and edit code' },
  { key: 'coding.execute', label: 'Execute code', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'Run code in an ephemeral docker/bwrap sandbox — no network, capped resources, read-only' },
  { key: 'source.modify', label: 'Modify the source', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'Change the source of the hive itself — gated by the proposal pipeline: study, authorize, test, approve, merge' },
  { key: 'github.write', label: 'Write to GitHub', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'File an issue, open a PR, comment or close on the repository — the hub is the ONLY credential holder, and every write passes this gate' },
  { key: 'local.computation', label: 'Local computation', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Local CPU/math/time work' },
  { key: 'image.generate', label: 'Image generation', tier: 'compute', default_verdict: 'allow', requires_consent: false, description: 'Generate images' },
  { key: 'web.search', label: 'Web search', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'Query the open internet — human-approved per grant' },
  { key: 'web.fetch', label: 'Fetch URL', tier: 'side-effect', default_verdict: 'ask', requires_consent: true, description: 'Fetch a URL — arbitrary egress, human-approved per grant' },
  { key: 'data.file.read', label: 'Read & search files', tier: 'data', default_verdict: 'ask', requires_consent: true, description: 'Read and search documents — human-approved per grant' },
  { key: 'data.memory', label: 'Remember between chats', tier: 'data', default_verdict: 'allow', requires_consent: false, description: 'Store and recall notes scoped to the requester' },
  { key: 'database.query', label: 'Database query', tier: 'data', default_verdict: 'ask', requires_consent: true, description: 'Read-only queries against stored state' },
  { key: 'human.approval', label: 'Ask a human', tier: 'control', default_verdict: 'allow', requires_consent: false, description: 'The MAYBE path itself' },
  { key: 'financial.transaction', label: 'Spend money', tier: 'money', default_verdict: 'deny', requires_consent: true, description: 'Reserved — no backend yet' },
  { key: 'physical.world', label: 'Act on the physical world', tier: 'physical', default_verdict: 'deny', requires_consent: true, description: 'Reserved — printers / IoT / robots' },
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
      // heartbeat-fresh — a rehydrated 'stale' bee is not online
      const live = typeof orchestrator.isLive === 'function' ? orchestrator.isLive(node) : node.status !== 'offline';
      if (live) { e.online++; e.nodes.push(node.name || node.node_id); }
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
