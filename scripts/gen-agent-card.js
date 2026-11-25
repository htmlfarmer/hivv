#!/usr/bin/env node
// scripts/gen-agent-card.js — regenerate the static A2A agent card.
//
// The card is served two ways:
//
//   * the STATIC file (public_html/.well-known/agent-card.json) — Caddy
//     serves it with no gateway involvement, so a peer can discover us even
//     when the gateway is busy. This is the copy that matters for uptime.
//   * the LIVE route (/api/a2a/agent-card) — includes anything computed at
//     request time.
//
// The static copy is GENERATED from the route so the two cannot drift. Run
// this after changing the card:
//
//     node scripts/gen-agent-card.js
//
// It refuses to write if the result would not be valid JSON, and it writes
// BOTH well-known paths (the v1.0 name and the v0.2 name) with identical
// content — a card is a card.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const API = path.join(REPO, 'api');
const OUT_DIR = path.join(REPO, 'public_html', '.well-known');

let A2ARoutes;
try {
    A2ARoutes = require(path.join(API, 'routes', 'a2a-routes.js'));
} catch (err) {
    console.error('[agent-card] could not load the route:', err.message);
    process.exit(1);
}

const card = A2ARoutes.agentCard();
const text = JSON.stringify(card, null, 2) + '\n';

// Fail loudly rather than writing a broken card.
try {
    JSON.parse(text);
} catch (err) {
    console.error('[agent-card] the card did not serialize:', err.message);
    process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = ['agent-card.json', 'agent.json'];
for (const name of targets) {
    const file = path.join(OUT_DIR, name);
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (previous === text) {
        console.log(`[agent-card] ${name} — unchanged`);
        continue;
    }
    fs.writeFileSync(file, text);
    console.log(`[agent-card] ${name} — written (${text.length} bytes)`);
}
