'use strict';

// api/lib/proposal-study.js — ONE proposal, and everything it touches.
//
// The list door answers "what is there". This answers "what is going on
// with THIS one": the hive's reasoning, every bee that agreed and what else
// that bee has done, the artifacts it produced, whether the receipt chain
// still verifies, and what actually shipped.
//
// Extracted from the route so TWO surfaces can ask the same question —
// GET /api/proposals/:id/study and the MCP `proposals` tool — and cannot
// drift apart in what they report.

const proposal = require('./proposal');

// The files a unified diff touches — used when a proposal was filed without
// an explicit file list (a written-up .md, or a patch from before that field
// existed).
function filesOf(patch) {
  const out = [];
  for (const line of String(patch).split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    let f = line.slice(4).split('\t')[0].trim();
    if (f.startsWith('b/')) f = f.slice(2);
    if (f && f !== '/dev/null' && !out.includes(f)) out.push(f);
  }
  return out;
}

// Honey actually paid for a merge, read from the LEDGER — the same rows the
// leaderboard sums, so the two can never disagree about what a bee earned.
async function honeyAwardedTo(nodeId) {
  if (!nodeId) return null;
  try {
    // Lazy require: server.js requires this module at boot, so a top-level
    // import here would be circular.
    const server = require('../server');
    const pool = server && server.pool;
    if (!pool) return null;
    const r = await pool.query(
      "SELECT COALESCE(SUM(amount),0)::int AS h FROM hivv_honey_events "
      + "WHERE node_id = $1 AND kind = 'proposal_merged'",
      [nodeId]);
    return r.rows[0] ? Number(r.rows[0].h) : null;
  } catch (_e) {
    return null;   // a local gateway has no database and still answers
  }
}

// Bee context: honey, rank, how much else they have done.
async function beeInfo(id) {
  const info = { node_id: id };
  try {
    const honey = require('./honey');
    const prof = await honey.profile(id);
    if (prof) {
      return {
        node_id: id,
        honey: Number(prof.honey) || 0,
        bee_rank: prof.bee_rank || null,
        streak_days: Number(prof.streak_days) || 0,
        jobs_completed: Number(prof.jobs_completed) || 0,
      };
    }
  } catch (_e) { /* no database — the node id alone is still honest */ }
  return info;
}

async function study(id) {
  const p = proposal.get(id);
  if (!p) return null;

  const patch = proposal.patchOf(p.id);
  const files = (p.files_changed && p.files_changed.length)
    ? p.files_changed
    : (patch ? filesOf(patch) : []);

  // ── the bees behind it ──
  const beeIds = new Set(
    [p.node_id, ...(p.votes || []).map(v => v.node_id)].filter(Boolean));
  const bees = [];
  for (const bid of beeIds) bees.push(await beeInfo(bid));

  // ── artifacts ──
  const artifacts = {
    issue_url: p.issue_url || null,
    issue_number: p.issue_number || null,
    filed_via: p.filed_via || null,
    branch: (p.state === 'merged' || p.state === 'approved' || p.state === 'deployed')
      ? 'hive/proposal-' + p.id : null,
    pull_request: p.issue_url && /\/pull\//.test(p.issue_url) ? p.issue_url : null,
    files: files.slice(0, 60),
    file_count: files.length,
    patch_bytes: p.patch_bytes || 0,
    patch_sha256: p.patch_sha256 || null,
  };

  // ── gates + receipt chain ──
  const chain = proposal.verifyChain(p);
  const gates = {};
  for (const g of proposal.GATE_ORDER) {
    const gate = (p.gates || {})[g] || {};
    gates[g] = {
      status: gate.status || 'pending',
      at: gate.at || null,
      by: gate.by || null,
      problems: gate.problems || [],
    };
  }

  // ── what shipped ──
  let shipped = null;
  if (p.state === 'merged' || p.state === 'deployed') {
    shipped = {
      kind: 'proposal_merged',
      to: p.node_id || null,
      amount: await honeyAwardedTo(p.node_id),
    };
  }

  // ── related ──
  const all = proposal.list({ limit: 500 });
  const brief = (x) => ({ id: x.id, title: x.title, state: x.state });
  const related = {
    same_author: all.filter(x => x.id !== p.id && p.node_id && x.node_id === p.node_id)
      .slice(0, 8).map(brief),
    same_idea: all.filter(x => x.id !== p.id && p.dedupe_key && x.dedupe_key === p.dedupe_key)
      .map(brief),
    also_protected: all.filter(x => x.id !== p.id && x.protected_hit)
      .slice(0, 5).map(brief),
  };

  return {
    proposal: p,
    said: { verdict: p.verdict, screen: p.screen, reviews: p.reviews || [] },
    agreed: (p.votes || []).map(v => ({
      node_id: v.node_id || null,
      principal: v.principal || null,
      verdict: v.verdict || null,
      at: v.at || null,
    })),
    bees,
    artifacts,
    gates,
    chain: { ok: chain.ok, problems: chain.problems, chain_hash: p.chain_hash },
    shipped,
    related,
  };
}

module.exports = { study, filesOf, honeyAwardedTo, beeInfo };
