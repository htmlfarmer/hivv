// api/lib/redis-test.js — D2: Redis connectivity test (sessions not migrated yet).
// Tests REDIS_URL connectivity; logs result but does NOT change any behaviour.
// Real session migration: future work (see HIVV_BACKLOG.md D2).

const { createClient } = require('redis');

let client = null;
let status = 'not_configured'; // not_configured | connecting | connected | error
let errorMessage = null;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function testConnection() {
  if (REDIS_URL === 'redis://localhost:6379' && !process.env.REDIS_URL) {
    status = 'not_configured';
    return { status, url: 'redis://localhost:6379 (default, REDIS_URL not set)', note: 'set REDIS_URL to enable' };
  }
  status = 'connecting';
  try {
    client = createClient({ url: REDIS_URL });
    client.on('error', (err) => {
      status = 'error';
      errorMessage = err.message;
    });
    await client.connect();
    const pong = await client.ping();
    status = 'connected';
    errorMessage = null;
    await client.quit();
    client = null;
    return { status, url: REDIS_URL, ping: pong, note: 'Redis is reachable' };
  } catch (e) {
    status = 'error';
    errorMessage = e.message;
    try { if (client) await client.quit(); } catch (_) {}
    client = null;
    return { status, url: REDIS_URL, error: e.message, note: 'Redis unreachable — sessions stay in-memory (OK for now)' };
  }
}

function getStatus() {
  return { status, url: REDIS_URL, error: errorMessage };
}

module.exports = { testConnection, getStatus };
