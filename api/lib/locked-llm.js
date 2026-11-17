'use strict';

// ── keyed ("locked") LLM detection → incident plan ─────────────────────────
// A bee's heartbeat reports local_models[] entries with locked:true when its
// llama-server answers401-with-api-key (see hivv-cli `_detect_local_ai`).
// Those servers are visible in `hivv nodes` but unusable: hive peers AND the
// bee's own review brains get 401 (yalla 2026-11-14). hivv never sets llama
// API keys — it's operator config on that box — so the incident must carry
// the exact on-box commands to confirm/remove it.
//
// Pure module (no DB, no orchestrator): the server.js 60s health sweep calls
// plan() and applies creates/resolves. Unit-tested in api/tests/locked-llm.test.js.

const TITLE_MARKER = 'LLM locked'; // dedup key: incident title startsWith marker

function lockedModelsOf(node) {
    if (!node || typeof node !== 'object' || node.status !== 'online') return [];
    return (Array.isArray(node.local_models) ? node.local_models : [])
        .filter(m => m && typeof m === 'object' && m.locked);
}

function describeLocked(node, models) {
    const name = node.name || node.node_id || node.id || 'unknown';
    const ports = models.map(m => `:${m.port || 8080}`).join(', ');
    return (
        `${name} reports keyed LLM server(s) at ${ports} (llama-server started with ` +
        `--api-key or --api-key-file). The hive gets 401 on those ports — this bee's own ` +
        `review brains too — so the servers are advertised but never routed to (router skips ` +
        `m.locked). hivv never sets llama API keys; check the launch on ${name}: ` +
        `\`ps -ef | grep llama-server\` (note the PPID — if it isn't 1/systemd, follow it: ` +
        `\`ps -p <ppid> -o cmd=\`) and \`systemctl cat llama.service\`. ` +
        `Fix: remove the --api-key-file/--api-key flag from that launcher line, then restart ` +
        `it (or, for a real unit: \`hivv repair ${name} --op service_restart --unit llama.service\` ` +
        `— run that FROM THE HUB HOST, bees get 'control auth required'). ` +
        `LAN exposure stays governed by \`hivv firewall\`. The incident auto-resolves once ` +
        `the bee's heartbeat reports no keyed servers.`
    );
}

/**
 * Decide this sweep's actions.
 * @param nodes            iterable of node records (orchestrator shape);
 *                         node_id may come from the record or be injected.
 * @param activeIncidents  rows [{id, node_id, title}] of ACTIVE incidents —
 *                         only titles starting with TITLE_MARKER are considered.
 * @returns {{create: Array<{node_id, title, description, evidence}>, resolve: string[]}}
 *   create: one incident per bee reporting locked models (deduped);
 *   resolve: incident ids whose bee no longer reports locked models.
 */
function plan(nodes, activeIncidents) {
    const create = [];
    const resolve = [];
    const activeByNode = new Map();
    for (const inc of activeIncidents || []) {
        if (inc && typeof inc.title === 'string' && inc.title.startsWith(TITLE_MARKER)
                && inc.node_id != null) {
            activeByNode.set(String(inc.node_id), inc.id);
        }
    }
    const stillLocked = new Set();
    for (const node of nodes || []) {
        if (!node || typeof node !== 'object') continue;
        const models = lockedModelsOf(node);
        const nodeId = node.node_id != null ? node.node_id : node.id;
        if (!models.length || nodeId == null) continue;
        stillLocked.add(String(nodeId));
        if (activeByNode.has(String(nodeId))) continue; // already alerted
        const name = node.name || nodeId;
        create.push({
            node_id: nodeId,
            title: `${TITLE_MARKER} on ${name}: api-key required`,
            description: describeLocked(node, models),
            evidence: {
                kind: 'locked_models',
                models: models.map(m => ({
                    provider: m.provider || null,
                    model: m.model || null,
                    port: m.port || null,
                })),
            },
        });
    }
    for (const [nodeId, incidentId] of activeByNode) {
        if (!stillLocked.has(nodeId)) resolve.push(incidentId);
    }
    return { create, resolve };
}

module.exports = { plan, lockedModelsOf, describeLocked, TITLE_MARKER };
