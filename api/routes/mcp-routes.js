// api/routes/mcp-routes.js — MCP (Model Context Protocol) server for AI agents.
// Plan B of HIVV_OPENCODE_PLAN.md: `opencode mcp add hivv --url https://hivv.org/mcp`.
//
// Mounted at /mcp by server.js (lead agent wires it — inject pattern matches
// capability-routes.js, relay-routes.js, honey-routes.js):
//
//   const McpRoutes = require('./routes/mcp-routes');
//   McpRoutes.inject(orch, router);        // orchestrator + AIRouter singletons
//   app.use('/mcp', McpRoutes);
//
// Transport: remote MCP over Streamable HTTP, STATELESS — a fresh McpServer +
// StreamableHTTPServerTransport per POST (sessionIdGenerator: undefined,
// enableJsonResponse: true → single application/json JSON-RPC replies). No
// server-initiated stream, so GET/DELETE/PUT/PATCH answer 405 (the spec allows
// stateless servers to not offer a server→client SSE stream).
//
// Methods: initialize · notifications/initialized · ping · tools/list · tools/call.
// Unknown method → -32601 (SDK built-in); invalid params → -32602 (pre-validated
// here with the same zod shapes the tools are registered with).
//
// Auth: optional `Authorization: Bearer <api_key>` → principal `user:<id>`
// (`SELECT id FROM users WHERE api_key = $1`, lazy pool import exactly like
// control-routes.js). Absent/empty → anonymous visitor tier (still rate-limited).
// Bad key → HTTP 401 with a JSON-RPC error body. Limit: 60 req/min/IP — the same
// IPBasedLimiter class server.js uses as `ipLimiter` for chat.
//
// Policy: MCP is a transport, not a bypass. `chat` goes through
// router.chatCompletion → the same gate as POST /api/chat (denied → tool error,
// MAYBE → tell the human to run `hivv approve <grant_id>`); `search`/`news` pass
// policy.gate(web.search) exactly like GET /api/tools/:tool/invoke.

const express = require('express');
const router = express.Router();

const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const honey = require('../lib/honey');
const caps = require('../lib/capabilities');
const policy = require('../lib/policy');
const { IPBasedLimiter } = require('../lib/rate-limiter');
const pkg = require('../package.json');

// ── injected by server.js (same pattern as capability-routes.js) ────────────
let orchestrator = null;
let aiRouter = null;
router.inject = (orch, rt) => {
  orchestrator = orchestrator || orch;
  aiRouter = aiRouter || rt;
};

// Same limiter class server.js instantiates as `ipLimiter` for chat: 60 req/min/IP.
const ipLimiter = new IPBasedLimiter();
setInterval(() => ipLimiter.cleanup(), 60000).unref();

// Same identity nudge server.js prepends on /api/chat (HIVE pronunciation).
const HIVV_IDENTITY_MSG = {
  role: 'system',
  content: 'IMPORTANT: When referring to the hivv.org distributed AI network, always write "HIVE" (pronounced /haɪv/, like a beehive) — never spell it as "HIV" or "H-I-V". The project name is HIVV and it rhymes with "hive".'
};

// ── small helpers ───────────────────────────────────────────────────────────

function _rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function _idOf(body) {
  if (Array.isArray(body)) return null;
  if (body && typeof body === 'object' && 'id' in body) return body.id ?? null;
  return null;
}

function _isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function _withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function _fetchText(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'hivv-mcp/1.0 (+https://hivv.org)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(to); }
}

async function _fetchJson(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'hivv-mcp/1.0 (+https://hivv.org)' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

function _text(s) { return { content: [{ type: 'text', text: String(s) }] }; }
function _json(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }; }
function _err(msg) { return { content: [{ type: 'text', text: String(msg) }], isError: true }; }

// ── tool schemas (raw zod shapes — registered AND reused for -32602 pre-validation)

const MODES = ['balanced', 'quality', 'fast', 'cost', 'private', 'trusted'];
const MODE_DESC = 'Routing strategy: balanced = everyday default · quality = smartest model · '
  + 'fast = lowest latency · cost = cheapest/free · private = data never leaves the hive · '
  + 'trusted = highest-ranked bees only';

const MESSAGE_SHAPE = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']).describe('who wrote this message'),
  content: z.any().describe('message text (string) or content-parts array')
});

const CHAT_SHAPE = {
  message: z.string().optional()
    .describe('Convenience: a single user message. Use this for one-shot questions instead of `messages`.'),
  messages: z.array(MESSAGE_SHAPE).optional()
    .describe('Full conversation transcript [{role, content}, ...] — use when you need history or a system prompt. Takes precedence over `message`.'),
  mode: z.enum(MODES).optional().describe(MODE_DESC)
};

const ROUTE_SHAPE = {
  query: z.string().describe('The question you WOULD ask — shown in the preview for context only; nothing is sent to any model.'),
  mode: z.enum(MODES).optional().describe(MODE_DESC)
};

const WEB_SHAPE = {
  query: z.string().describe('What to look up — the search terms or news topic.'),
  location: z.string().optional().describe('Optional place/context to bias results (e.g. a city for news: query=earthquake, location=Tokyo).')
};

const HONEY_SHAPE = {
  node: z.string().optional().describe("Optional node name/id — pass it to see ONE bee's profile (rank, streak, jobs) instead of the top-20 leaderboard.")
};

const NO_ARGS_SHAPE = {};

const TOOL_DEFS = {
  chat: {
    title: 'Chat with the hive',
    description: 'Ask the hivv hive any question — routed to the best available AI (local bee → direct node → relay → cloud). '
      + 'Use for general Q&A, reasoning, writing, explanations and code help. Returns the answer plus a receipt naming the bee/model that served it (answered_by) and the route taken. '
      + 'Pass `mode` to steer routing: quality = smartest model, fast = lowest latency, cost = cheapest/free, private = never leaves the hive, trusted = highest-ranked bees.',
    shape: CHAT_SHAPE, schema: z.object(CHAT_SHAPE)
  },
  route: {
    title: 'Preview routing (dry-run)',
    description: 'Ask BEFORE spending: see which AI would answer and why — a dry-run preview scoring candidates on speed/quality/trust, '
      + 'listing transports (local/direct/relay/cloud) and the policy verdict. Executes NOTHING and sends no model request. '
      + 'Use to answer "which AI would answer this and why", compare route modes, or check cost/privacy before calling `chat`.',
    shape: ROUTE_SHAPE, schema: z.object(ROUTE_SHAPE)
  },
  nodes: {
    title: 'List hive nodes',
    description: 'List the bees (computers) registered in the hivv hive right now — name, status, honey rank, local models, shared tools, last heartbeat. '
      + 'Use for cluster-status questions: "which nodes are online?", "what models does the hive run?", "who is volunteering compute?".',
    shape: NO_ARGS_SHAPE, schema: z.object(NO_ARGS_SHAPE)
  },
  search: {
    title: 'Web search',
    description: 'Live web/Wikipedia search for facts, definitions, history, people and places. '
      + 'Use for factual lookups; prefer the `news` tool for current events. Returns top results with titles, snippets and links.',
    shape: WEB_SHAPE, schema: z.object(WEB_SHAPE)
  },
  news: {
    title: 'Latest news',
    description: 'Latest news headlines (Google News) for a topic or place. '
      + 'Use for current events, breaking news and "what is happening in X" questions. Combine `query` with `location` (e.g. query=earthquake, location=Tokyo).',
    shape: WEB_SHAPE, schema: z.object(WEB_SHAPE)
  },
  honey: {
    title: 'Honey leaderboard',
    description: 'Contribution leaderboard of the hive: honey earned (1/minute online, 10/job, 1/100 tokens), bee rank (larva → queen-bee) and streaks. '
      + 'Use for "who contributes the most?", "what is my rank?" or other gamification questions; pass `node` for one bee’s full profile.',
    shape: HONEY_SHAPE, schema: z.object(HONEY_SHAPE)
  }
};

// ── tool implementations ────────────────────────────────────────────────────

function _normalizeMessages(args) {
  if (Array.isArray(args?.messages) && args.messages.length) {
    const out = [];
    for (const m of args.messages) {
      if (!_isPlainObject(m)) return null;
      const role = String(m.role || '').toLowerCase();
      if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
      let content = m.content;
      if (content === undefined || content === null) content = '';
      if (typeof content !== 'string' && !Array.isArray(content)) content = JSON.stringify(content);
      out.push({ role, content });
    }
    return out;
  }
  if (typeof args?.message === 'string' && args.message.trim()) {
    return [{ role: 'user', content: args.message }];
  }
  return null;
}

async function _toolChat(args, ctx) {
  const messages = _normalizeMessages(args);
  if (!messages) return _err('Invalid arguments: provide either `messages` (array of {role, content}) or `message` (string).');
  if (!aiRouter) return _err('Chat router not ready — the hub is still starting, retry in a moment.');

  const mode = typeof args.mode === 'string' && MODES.includes(args.mode) ? args.mode : null;
  const data = await _withTimeout(aiRouter.chatCompletion([HIVV_IDENTITY_MSG, ...messages], {
    stream: false,
    userId: ctx.userId || undefined,
    principal: ctx.principal,
    capability: 'reasoning',
    route: mode ? { mode } : {},
    via: 'mcp',
    reason: 'mcp chat tool',
    timeout: 120000
  }), 150000, 'chat');

  if (!data || !data.ok) {
    if (data?.denied) {
      const rule = data.policy?.rule ? ` (${data.policy.rule})` : '';
      return _err(`Policy denied: ${data.error || 'denied by policy'}${rule}`);
    }
    if (data?.asked) {
      const gid = data.policy?.grant_id || '<grant_id>';
      return _err(`MAYBE — human approval required before this can run. Ask the operator to run: hivv approve ${gid} — then ask again.`);
    }
    if (data?.privacyBlocked) return _err(data.error || 'Blocked: privacy mode keeps this request inside the hive and no hive target was available.');
    if (data?.costBlocked) return _err(data.error || 'Blocked: cost limit exceeded for this request.');
    return _err(data?.error || 'The hive could not answer — no AI target was available, retry shortly.');
  }

  const answer = data.data?.choices?.[0]?.message?.content;
  const receipt = {
    answered_by: data.answeredBy || null,
    route: {
      mode: mode || 'balanced',
      provider: data.provider || null,
      model: data.servedModel || null
    }
  };
  return {
    content: [
      { type: 'text', text: typeof answer === 'string' && answer.length ? answer : '(empty answer)' },
      { type: 'text', text: JSON.stringify(receipt) }
    ]
  };
}

async function _toolRoute(args, ctx) {
  if (!aiRouter) return _err('Router not ready — the hub is still starting, retry in a moment.');
  const mode = typeof args.mode === 'string' && MODES.includes(args.mode) ? args.mode : 'balanced';
  const preview = await _withTimeout(
    aiRouter.routePreview({ capability: 'reasoning', mode, principal: ctx.principal }),
    20000, 'route preview'
  );
  return _json({ query: args.query || null, ...preview });
}

async function _toolNodes() {
  if (!orchestrator || !orchestrator.nodes) {
    return _err('Node registry unavailable — the hub is still starting, retry in a moment.');
  }
  // honey ranks are "easy if available" — never let a DB blip kill the node list
  let rankBy = {};
  try {
    const rows = await _withTimeout(honey.leaderboard({ window: 'all', limit: 1000 }), 8000, 'honey leaderboard');
    for (const r of rows) rankBy[r.node_id] = r;
  } catch (e) {
    console.warn('[MCP] honey ranks unavailable:', e.message);
  }
  const now = Date.now();
  const all = Array.from(orchestrator.nodes.values());
  const nodes = all.map((n) => {
    const st = rankBy[n.node_id];
    return {
      node_id: n.node_id,
      name: n.name,
      status: n.status,
      bee_rank: st?.bee_rank || null,
      honey: st?.honey ?? null,
      local_models: (n.local_models || []).map((m) => m.model || m.name).filter(Boolean),
      tools: n.tools || [],
      last_heartbeat: n.last_heartbeat ? new Date(n.last_heartbeat).toISOString() : null,
      heartbeat_age_s: n.last_heartbeat ? Math.round((now - n.last_heartbeat) / 1000) : null,
      volunteer: n.volunteer === true || n.volunteer?.on === true,
      version: n.version || null
    };
  });
  return _json({
    total: nodes.length,
    // heartbeat-fresh, not "not marked offline" — see orchestrator.isLive
    online: nodes.filter((n) => (typeof orchestrator.isLive === 'function' ? orchestrator.isLive(n) : n.status !== 'offline')).length,
    nodes
  });
}

// Node-hosted hivv-tools — same mechanism as GET /api/tools/:tool/invoke in
// server.js: least-loaded node advertising the tool, lan_ip → ip → loopback,
// 8s timeout per host. Returns the JSON text, or null so the caller can fall back.
async function _invokeNodeTool(tool, q) {
  if (!orchestrator || !orchestrator.nodes) return null;
  const all = Array.from(orchestrator.nodes.values())
    .filter((n) => (typeof orchestrator.isLive === 'function' ? orchestrator.isLive(n) : n.status !== 'offline')
      && (n.tools || []).includes(tool) && n.tools_port > 0);
  if (!all.length) return null;
  const node = all.sort((a, b) => (a.total_cpu_percent || 0) - (b.total_cpu_percent || 0))[0];
  const qs = new URLSearchParams({ q });
  const hosts = [];
  if (node.lan_ip) hosts.push(node.lan_ip);
  if (node.ip && node.ip !== node.lan_ip) hosts.push(node.ip);
  hosts.push('127.0.0.1', 'localhost');
  let lastErr = null;
  for (const host of hosts) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(`http://${host}:${node.tools_port}/${tool}?${qs}`, { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
      const data = await r.json();
      return JSON.stringify({ tool, node: node.name, data }, null, 2);
    } catch (e) { lastErr = e; }
  }
  console.warn(`[MCP] node-hosted ${tool} failed on ${node.name}:`, lastErr?.message || 'no route');
  return null;
}

// Hub-local fallbacks — the exact implementations server.js runs in execToolCall
// (Wikipedia search / Google News RSS), used when no bee shares the tool.
async function _hubSearch(query) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json&origin=*`;
  const data = await _fetchJson(url, 8000);
  let out = `Search results for "${query}":\n\n`;
  const results = (data && data.query && data.query.search) || [];
  if (!results.length) return out + 'No results found.\n';
  results.forEach((r, i) => {
    const snippet = String(r.snippet || '').replace(/<[^>]+>/g, '');
    out += `${i + 1}. ${r.title}\n   ${snippet}\n   https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}\n\n`;
  });
  return out.slice(0, 1500);
}

async function _hubNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const body = await _fetchText(url, 8000);
  const itemRegex = /<item[^>]*>[\s\S]*?<\/item>/gi;
  const items = body.match(itemRegex) || [];
  let out = `Latest news for "${query}":\n\n`;
  for (let i = 0; i < Math.min(items.length, 8); i++) {
    const titleMatch = items[i].match(/<title>(.*?)<\/title>/i);
    const linkMatch = items[i].match(/<link>(.*?)<\/link>/i);
    const pubDateMatch = items[i].match(/<pubDate>(.*?)<\/pubDate>/i);
    const descMatch = items[i].match(/<description>(.*?)<\/description>/i);
    const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[|\]\]>/gi, '').trim() : 'No title';
    const link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/gi, '').trim() : '';
    const pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';
    let desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : '';
    if (desc.length > 200) desc = desc.slice(0, 200) + '...';
    if (title && title !== 'Google News') {
      out += `• ${title}\n`;
      if (pubDate) out += `  ${pubDate}\n`;
      if (desc) out += `  ${desc}\n`;
      if (link) out += `  ${link}\n`;
      out += '\n';
    }
  }
  if (out.trim() === `Latest news for "${query}":`) out += 'No news articles found.\n';
  return out.slice(0, 2000);
}

async function _toolWeb(tool, args, ctx) {
  const query = String(args?.query || '').trim();
  const location = String(args?.location || '').trim();
  if (!query && !location) return _err('Invalid arguments: `query` is required.');

  // hivv OS §3 — same gate as GET /api/tools/:tool/invoke (fail-open on gate failure)
  try {
    const g = await _withTimeout(policy.gate({
      capability: caps.toolToCap(tool),
      principal: ctx.principal,
      transport: 'mcp',
      args_summary: { tool, q: (query || location).slice(0, 120) },
      reason: `mcp ${tool}`,
      node: ctx.nodeId || null
    }), 8000, 'policy gate');
    if (g.verdict === 'deny') return _err(`policy refused '${g.key}' — ${g.rule}`);
    if (g.verdict === 'ask') return _err(`MAYBE — human approval required. Ask the operator to run: hivv approve ${g.grant_id} — then ask again.`);
  } catch (e) {
    console.warn('[MCP] policy gate error:', e.message);
  }

  const q = [query, location].filter(Boolean).join(' ');
  const viaNode = await _invokeNodeTool(tool, q);
  if (viaNode) return _text(viaNode);
  try {
    const out = tool === 'news' ? await _hubNews(q || 'news') : await _hubSearch(q);
    return _text(out);
  } catch (e) {
    return _err(`${tool} failed: no hive node had the tool available and the hub fallback errored (${e.message || e}).`);
  }
}

async function _toolHoney(args) {
  if (args?.node) {
    const p = await _withTimeout(honey.profile(String(args.node)), 10000, 'honey profile');
    if (!p) return _err('No honey stats yet for that node.');
    return _json(p);
  }
  const bees = await _withTimeout(honey.leaderboard({ window: 'all', limit: 20 }), 10000, 'honey leaderboard');
  return _json({ bees });
}

// ── registration (one McpServer per request — the SDK stateless pattern) ────

// ── the toolkit's twelve, exposed over MCP ─────────────────────────────────
//
// The MCP server used to offer six tools: chat, route, nodes, search, news
// and honey. The toolkit (api/lib/toolkit.js) is the canonical catalog for
// everything an AI can DO, so the MCP surface now carries all of it — an
// MCP client gets the same tools as a model talking to /api/chat, from the
// same implementation, with the same policy gate in front of them.
//
// The tool parameters are declared once, as JSON Schema, in the toolkit.
// MCP wants zod, so the shape is derived from that one declaration — there
// is no second copy to drift.

const toolkit = require('../lib/toolkit');

/** JSON Schema (the toolkit's shape) → a zod shape (what MCP wants). */
function _zodField(def, required) {
    let field;
    const type = def.type || 'string';
    if (Array.isArray(def.enum) && def.enum.length) {
        field = z.enum(def.enum);
    } else if (type === 'integer') {
        field = z.number().int();
    } else if (type === 'number') {
        field = z.number();
    } else if (type === 'boolean') {
        field = z.boolean();
    } else if (type === 'array') {
        field = z.array(def.items && def.items.type === 'string' ? z.string() : z.any());
    } else if (type === 'object') {
        field = z.record(z.string(), z.any());
    } else {
        field = z.string();
    }
    if (def.description) field = field.describe(def.description);
    return required ? field : field.optional();
}

function _zodShape(params) {
    const shape = {};
    const required = new Set((params && params.required) || []);
    for (const [key, def] of Object.entries((params && params.properties) || {})) {
        shape[key] = _zodField(def, required.has(key));
    }
    return shape;
}

// name → {title, description, shape, schema}
const TOOLKIT_DEFS = new Map();
for (const t of toolkit.advertisedTools()) {
    const shape = _zodShape(t.parameters);
    TOOLKIT_DEFS.set(t.name, {
        title: t.name.replace(/_/g, ' '),
        description: t.description,
        shape,
        schema: z.object(shape),
        tool: t,
    });
}

function _dispatch(name, args, ctx) {
  switch (name) {
  case 'chat':  return _toolChat(args, ctx);
  case 'route': return _toolRoute(args, ctx);
  case 'nodes': return _toolNodes(ctx);
  case 'search': return _toolWeb('search', args, ctx);
  case 'news':  return _toolWeb('news', args, ctx);
  case 'honey': return _toolHoney(args);
  default:      return Promise.resolve(_err(`Unknown tool: ${name}`));
  }
}

function _registerTools(server, ctx) {
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    server.registerTool(name, {
      title: def.title,
      description: def.description,
      inputSchema: def.shape
    }, async (args) => {
      console.log(`[MCP] tools/call ${name} ← ${ctx.principal}`);
      try {
        return await _dispatch(name, args || {}, ctx);
      } catch (e) {
        console.warn(`[MCP] tools/call ${name} failed:`, e.message);
        return _err(`${name} failed: ${e.message || 'unexpected error'}`);
      }
    });
  }
  // The toolkit's tools — the same implementation the chat path uses.
  for (const [name, def] of TOOLKIT_DEFS) {
    server.registerTool(name, {
      title: def.title,
      description: def.description,
      inputSchema: def.shape
    }, async (args) => {
      console.log(`[MCP] tools/call ${name} ← ${ctx.principal}`);
      try {
        const result = await toolkit.execute(name, args || {}, {
          principal: ctx.principal,
          transport: 'mcp',
          ip: ctx.ip || null,
          isAdmin: ctx.isAdmin === true,
          reason: `mcp ${name}`,
          node: ctx.nodeId || null,
          via: 'mcp',
        });
        if (result.policy && result.policy.verdict === 'deny') {
          return _err(`policy refused '${result.policy.capability}' — ${result.policy.rule}`);
        }
        if (result.policy && result.policy.verdict === 'ask') {
          return _err(`MAYBE — human approval required. Ask the operator to run: hivv approve ${result.policy.grant_id} — then ask again.`);
        }
        if (!result.ok) return _err(String(result.error || 'the tool failed'));
        return _json({ tool: result.tool, via: result.via, data: result.data, policy: result.policy || null });
      } catch (e) {
        console.warn(`[MCP] tools/call ${name} failed:`, e.message);
        return _err(`${name} failed: ${e.message || 'unexpected error'}`);
      }
    });
  }
}

// ── JSON-RPC pre-validation: deterministic -32602 for invalid params ────────
// (the SDK would swallow tool-arg schema failures into an isError tool result
// and map request-schema failures to -32603; the spec wants -32602.)
function _prevalidate(body) {
  const msgs = Array.isArray(body) ? body : [body];
  for (const m of msgs) {
    if (!_isPlainObject(m)) continue;               // let the SDK reject garbage
    const isRequest = typeof m.method === 'string' && 'id' in m && m.id !== null && m.id !== undefined;
    if (!isRequest) continue;
    const id = m.id;
    const fail = (message) => _rpcError(id, -32602, message);

    if (m.params !== undefined && !_isPlainObject(m.params)) {
      return fail('Invalid params: params must be an object');
    }
    if (m.method === 'ping' || m.method === 'initialize' || m.method === 'tools/list') {
      continue; // shapes beyond "object" are the SDK's business
    }
    if (m.method !== 'tools/call') continue;        // unknown methods → SDK -32601

    const params = m.params || {};
    const name = params.name;
    if (typeof name !== 'string' || !name) return fail('Invalid params: tools/call requires a string tool `name`');
    const def = TOOL_DEFS[name] || TOOLKIT_DEFS.get(name);
    if (!def) return fail(`Invalid params: Tool ${name} not found`);
    const args = params.arguments;
    if (args !== undefined && !_isPlainObject(args)) return fail(`Invalid params for tool ${name}: arguments must be an object`);
    if (args !== undefined) {
      const parsed = def.schema.safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error?.issues?.[0];
        const where = issue?.path?.length ? issue.path.join('.') : '(root)';
        return fail(`Invalid params for tool ${name}: ${where}: ${issue?.message || 'validation failed'}`);
      }
    }
  }
  return null;
}

// ── auth: optional Bearer api_key → user:<id>, else anonymous visitor tier ──

async function _authenticate(req) {
  const raw = req.headers['authorization'];
  const token = typeof raw === 'string' ? raw.replace(/^bearer\s+/i, '').trim() : '';
  if (!token) {
    const visitor = (req.signedCookies && req.signedCookies.hivv_visitor)
      || (typeof req.headers['x-visitor-id'] === 'string' && req.headers['x-visitor-id'])
      || `mcp:${req.ip || 'anon'}`;
    return { principal: String(visitor).slice(0, 128), userId: null };
  }
  // Lazy pool import — same pattern as control-routes.js / honey-routes.js
  let pool = null;
  try { pool = require('../server').pool; } catch (e) { pool = null; }
  if (!pool) return { status: 503, error: 'Auth backend unavailable — retry, or omit Authorization for the anonymous visitor tier.' };
  try {
    const r = await _withTimeout(
      pool.query('SELECT id FROM users WHERE api_key = $1', [token]),
      5000, 'auth lookup'
    );
    if (!r.rows.length) return { status: 401, error: 'Invalid API key' };
    return { principal: `user:${r.rows[0].id}`, userId: r.rows[0].id };
  } catch (e) {
    console.warn('[MCP] auth lookup failed:', e.message);
    return { status: 503, error: 'Auth backend unavailable — retry, or omit Authorization for the anonymous visitor tier.' };
  }
}

function _nodeIdOf(req) {
  const h = req.headers['x-hivv-node'];
  if (!h || typeof h !== 'string') return null;
  const s = h.trim().slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(s) ? s : null;
}

// Loopback only — the MCP surface has no admin token path, and it does not
// need one. The only thing "admin" unlocks is the web-search bypass, and
// that is already gated behind HIVV_ENABLE_WEB_SEARCH.
function _isLocal(req) {
  const ip = String(req.ip || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ── HTTP surface ────────────────────────────────────────────────────────────

async function _handlePost(req, res) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  const id = _idOf(req.body);

  // Same per-IP budget as /api/chat (60 req/min, in-memory)
  const rl = ipLimiter.check(ip);
  if (!rl.allowed) {
    res.set('Retry-After', '60');
    return res.status(429).json(_rpcError(id, -32000, 'Rate limit exceeded — 60 requests/min per IP'));
  }

  const auth = await _authenticate(req);
  if (auth.status) {
    if (auth.status === 401) res.set('WWW-Authenticate', 'Bearer');
    return res.status(auth.status).json(_rpcError(id, -32000, auth.error));
  }

  const bad = _prevalidate(req.body);
  if (bad) return res.status(200).json(bad);

  const ctx = {
    principal: auth.principal,
    userId: auth.userId,
    nodeId: _nodeIdOf(req),
    ip: req.ip || null,
    isAdmin: _isLocal(req),
  };

  // Stateless: fresh server + transport per POST (SDK simpleStatelessStreamableHttp pattern)
  const server = new McpServer({ name: 'hivv', version: pkg.version || '1.0.0' });
  _registerTools(server, ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    if (req.body && !Array.isArray(req.body) && req.body.method === 'initialize') {
      console.log(`[MCP] initialize from ${ip} as ${ctx.principal}`);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[MCP] request handling failed:', e.message);
    if (!res.headersSent) res.status(500).json(_rpcError(id, -32603, 'Internal server error'));
  }
}

const jsonBody = express.json({ limit: '256kb' });

router.post('/', (req, res, next) => {
  jsonBody(req, res, (err) => {
    if (err) return res.status(400).json(_rpcError(null, -32700, 'Parse error: invalid JSON body'));
    next();
  });
}, _handlePost);

// Stateless server: no server-initiated stream → GET (SSE) and writes are 405.
function _notAllowed(req, res) {
  res.set('Allow', 'POST');
  res.status(405).json(_rpcError(
    _idOf(req.body),
    -32000,
    `${req.method} not allowed — this stateless MCP endpoint only accepts POST (no server-initiated SSE stream)`
  ));
}
router.get('/', _notAllowed);
router.delete('/', _notAllowed);
router.put('/', _notAllowed);
router.patch('/', _notAllowed);

module.exports = router;
