// api/lib/horizon.js — the physical horizon warning.
//
// The edge/horizon problem: past a certain distance (or through a path you
// cannot see), you cannot verify a connection physically — you can only
// trust it. Private nodes, VPNs, tunnels, and cloud boxes all live BEYOND
// the horizon. So every answer now carries a horizon verdict:
//
//   within       — localhost, or a located peer within HIVV_HORIZON_MILES
//                  of the hive's core (default 5) — walkable, verifiable
//   beyond       — too far, or someone else's datacenter (cloud)
//   unverifiable — a private node / private connection / unknown location:
//                  we CANNOT confirm this path is physically real
//
// The verdict is emitted as the X-Hivv-Horizon header AND signed into the
// X-Hivv-Receipt — a warning you cannot strip is a warning that works.

const DEG = Math.PI / 180;
const EARTH_MI = 3958.8;

// The hive core's location — set once at startup from the router, so every
// horizon measurement has a fixed reference (the home of HOME hivv.org).
let _hubLoc = null;
function setHubLoc(loc) {
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) _hubLoc = loc;
  return _hubLoc;
}
function getHubLoc() { return _hubLoc; }

/** Configured horizon in miles (default 5). 0 or negative disables the
 *  distance rule (warnings still classify private/unknown as unverifiable). */
function horizonMiles(env = process.env) {
  const v = parseFloat(env.HIVV_HORIZON_MILES);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

/** Great-circle distance in miles. */
function haversineMiles(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(a.lon) ||
      !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return null;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Classify one answer's path.
 * @param {{isLocal?:boolean, isPeer?:boolean, isPrivatePath?:boolean,
 *          nodeLoc?:{lat:number,lon:number}|null, hubLoc?:{lat:number,lon:number}|null,
 *          miles?:number}} o
 * @returns {{status:'within'|'beyond'|'unverifiable', reason:string, miles:number}}
 */
function classify(o = {}) {
  const miles = o.miles != null ? o.miles : horizonMiles();

  if (o.isLocal) {
    return { status: 'within', reason: 'localhost — you can touch it', miles };
  }
  if (!o.isPeer) {
    // cloud: physically real, but never physically verifiable from here
    return { status: 'beyond', reason: 'cloud provider — outside the physical horizon', miles };
  }
  if (o.isPrivatePath) {
    return { status: 'unverifiable',
      reason: 'private node or private connection — path cannot be physically verified', miles };
  }
  if (!o.nodeLoc || !Number.isFinite(o.nodeLoc.lat) || !Number.isFinite(o.nodeLoc.lon)) {
    return { status: 'unverifiable',
      reason: 'node has no known location — beyond the physical horizon by default', miles };
  }
  const core = o.hubLoc || _hubLoc;
  if (core) {
    const d = haversineMiles(o.nodeLoc, core);
    if (d != null && d > miles) {
      return { status: 'beyond',
        reason: Math.round(d) + ' miles from the hive core (horizon ' + miles + ')', miles };
    }
    if (d != null) {
      return { status: 'within', reason: Math.round(d) + ' miles from the hive core', miles };
    }
  }
  // located peer, but we do not know where the core is: honest unknown
  return { status: 'unverifiable',
    reason: 'hive core location unknown — cannot measure the horizon', miles };
}

/** The X-Hivv-Horizon header value. HTTP headers are Latin-1 only (the
 *  same law that hides Arabic from ByteString headers) — so the display
 *  reason gets ASCII-folded for the header, while the SIGNED receipt keeps
 *  the original text (JSON bodies carry full Unicode happily). */
function header(v) {
  const s = (v.status || 'unknown') + (v.reason ? '; ' + v.reason : '');
  return s.replace(/[^\x20-\x7e]/g, '-');
}

// ── the ping floor (physics as evidence) ────────────────────────────────
// Signals in copper/fiber travel roughly a FOOT PER NANOSECOND (vacuum
// light = 0.98 ft/ns; real wire ~0.5-0.7c). Round trip means x2. So a
// measured minimum RTT gives a hard PHYSICAL bound:
//
//   implied_miles = rtt_ns x ft_per_ns / 2 / 5280
//
// Two uses, both honest:
//   · implied < claimed distance  -> the claim is FASTER THAN PHYSICS = lie
//   · implied <= horizon          -> PROVEN within the horizon (a home-LAN
//     node answering under ~53us for a 5-mile horizon is physically
//     verified — no trust required). Everything else is inconclusive,
//     which is what the warning is for.
const FT_PER_NS_DEFAULT = 1.0; // the classic rule of thumb

function impliedMiles(minRttNs, ftPerNs = FT_PER_NS_DEFAULT) {
  if (!Number.isFinite(minRttNs) || minRttNs <= 0) return null;
  return (minRttNs * ftPerNs) / 2 / 5280;
}

/**
 * Physics verdict from a ping.
 * @returns {{verdict:'proven-within'|'impossible'|'inconclusive', implied_miles:number|null}}
 */
function proveHorizon({ minRttNs, claimedMiles = null, miles = null, ftPerNs } = {}) {
  const horizon = miles != null ? miles : horizonMiles();
  const implied = impliedMiles(minRttNs, ftPerNs);
  if (implied == null) return { verdict: 'inconclusive', implied_miles: null };
  if (claimedMiles != null && implied < claimedMiles) {
    return { verdict: 'impossible',
      implied_miles: Math.round(implied * 1000) / 1000,
      note: 'answers faster than physics — the ' + claimedMiles +
        '-mile claim needs ' + Math.round(claimedMiles * 5280 * 2) + 'ns minimum' };
  }
  if (implied <= horizon) {
    return { verdict: 'proven-within',
      implied_miles: Math.round(implied * 1000) / 1000,
      note: 'round trip ' + Math.round(minRttNs) + 'ns proves distance <= ' +
        Math.round(implied * 1000) / 1000 + ' miles (horizon ' + horizon + ')' };
  }
  return { verdict: 'inconclusive', implied_miles: Math.round(implied * 1000) / 1000 };
}

// RFC1918/CGNAT/loopback — a private address means the path is a tunnel,
// VPN, or LAN hop we cannot walk to: unverifiable by definition.
function isPrivateIp(s) {
  const v = String(s || '').replace(/^::ffff:/, '');
  if (v === '::1' || v === '') return v === '::1';
  return /^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/.test(v);
}

/**
 * Classify from an X-Hivv-Answered-By value (server-side receipt sites):
 *   "localhost/model (direct)"  -> within (you can touch it)
 *   "bee/model (direct|relay)"  -> node path: look the bee up, use its location
 *   anything else               -> cloud/unknown: beyond
 */
function forAnsweredBy(answeredBy, nodeLookup) {
  const s = String(answeredBy || '');
  if (/^localhost/.test(s)) return classify({ isLocal: true });
  const isNodePath = /\((direct|relay)\)/.test(s);
  if (isNodePath) {
    const name = s.split('/')[0];
    const node = typeof nodeLookup === 'function' ? nodeLookup(name) : nodeLookup;
    const loc = node && node.location && Number.isFinite(node.location.lat)
      ? node.location : null;
    return classify({
      isPeer: true,
      isPrivatePath: node ? isPrivateIp(String(node.ip || node.lan_ip || '')) : false,
      nodeLoc: loc,
    });
  }
  return classify({ isPeer: false });
}

module.exports = { classify, haversineMiles, horizonMiles, header,
  setHubLoc, getHubLoc, impliedMiles, proveHorizon, FT_PER_NS_DEFAULT,
  isPrivateIp, forAnsweredBy };
