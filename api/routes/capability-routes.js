// api/routes/capability-routes.js — §1 of the capability/policy plan.
// Mounted at /api/capabilities (public reads; dry-run is read-only too).
//   GET /                 → registry + per-capability hive counts + tiers
//   GET /node/:id         → what one bee can do (derived, hub-truth)
//   GET /route/dry-run    → scored candidate table for a route mode, no execution

const express = require('express');
const router = express.Router();

const caps = require('../lib/capabilities');

let orchestrator = null;
let aiRouter = null;
let keyScopes = null;   // K4: verified scopes so a 'self' dry-run shows YOUR bees
router.inject = (orch, rt, ks) => { orchestrator = orch; aiRouter = rt; keyScopes = ks || null; };

router.get('/', async (req, res) => {
  try {
    const summary = await caps.hiveSummary(orchestrator);
    res.set('Cache-Control', 'public, max-age=10');
    res.json({
      capabilities: summary.registry,
      tiers: summary.tiers,
      total: summary.total,
      modes: ['balanced', 'quality', 'fast', 'cost', 'private', 'trusted'],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/node/:id', async (req, res) => {
  try {
    const node = orchestrator.nodes.get(req.params.id)
      || Array.from(orchestrator.nodes.values()).find(n => n.name === req.params.id);
    if (!node) return res.status(404).json({ error: 'node not found' });
    res.json({
      node_id: node.node_id,
      name: node.name,
      status: node.status,
      capabilities: caps.deriveNodeCaps(node),
      volunteer: node.volunteer === true || node.volunteer?.on === true,
      tools: node.tools || [],
      local_models: (node.local_models || []).map(m => m.model || m.name),
      privacy_tier: node.privacy_tier || 'any',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/capabilities/route/dry-run?capability=reasoning&mode=private&privacy=
router.get('/route/dry-run', async (req, res) => {
  try {
    const { capability = 'reasoning', mode = 'balanced', privacy = '' } = req.query;
    if (!aiRouter) return res.status(503).json({ error: 'router not injected' });
    const preview = await aiRouter.routePreview({
      capability, mode, privacy: privacy || undefined,
      principal: req.headers['x-visitor-id'] || null,
      // K4: verified scopes (signed cookie / proven node secret / session) —
      // a privacy=self dry-run then lists exactly the bees THAT caller may
      // reach. Unauthenticated → [] → self shows hub-local only, which is
      // the honest answer for an unverified caller.
      keyScopes: keyScopes ? await keyScopes(req) : [],
    });
    res.set('Cache-Control', 'no-store');
    res.json(preview);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
