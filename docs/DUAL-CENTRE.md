# Two centres for hivv.org

> HIVV is pronounced **HIVE** (like a beehive).

Running hivv.org from two boxes is worth doing: one box is a single point
of failure, and the hive is supposed to survive its own hub disappearing.

But "two boxes" is not one thing. There are **three kinds of deployment**,
and the rules for pairing them are different — and in one case they are
the opposite of each other. Getting this wrong is how a second box
silently breaks the first.

## The three cases

| case | what it is | two of them are... |
|---|---|---|
| **A — the centre** | the full hivv.org: database, TLS, the operator secrets, the gateway | **one site.** Their secrets MUST match. |
| **B — the home** | a self-hosted local-first install: no database, no TLS, its own models | **two sites.** Their identities MUST differ. |
| **C — the node** | a node-only box: no gateway, no database, no TLS — just a bee | **two bees.** Nothing to be interchangeable with. |

Case A is hivv.org as we run it. Case B is what `setup-local.sh` builds.
Case C is a box that only contributes compute — a masjid, a laptop, a
Jetson.

The rule that surprises people: **in case A the secrets must match; in
case B they must NOT.** Sharing a session secret between two homes means
one home can sign a cookie the other accepts — the same installation,
from two places.

## What is shared, and what is not

| thing | case A | case B | case C |
|---|---|---|---|
| the code | shared | shared | shared |
| the database | shared | **not needed** | **not needed** |
| `api/.session-secret` | **must match** | **must differ** | n/a |
| `api/.control-token` | **must match** | **must differ** | n/a |
| `api/.encryption-key` | **must match** | **must differ** | n/a |
| `api/.db-password` | **must match** | n/a | n/a |
| `~/.config/hivv/auth.json` (hub credentials) | **must match** | **must differ** | **must differ** |
| `~/.local/share/hivv/identity/` (the bee) | same bee for failover, different for capacity | **must differ** | **must differ** |
| the orchestrator roster | **does not travel** | n/a | n/a |

## The check

```bash
# on each box
scripts/portability/centre-parity.sh --report parity-$(hostname).json

# then compare, from either box
scripts/portability/centre-parity.sh --against parity-otherbox.json --mode centre
scripts/portability/centre-parity.sh --against parity-otherbox.json --mode home
scripts/portability/centre-parity.sh --against parity-otherbox.json --mode node
```

The mode picks the rule set. The report contains fingerprints, never
values, so it is safe to paste into chat.

Verdicts:

- **not interchangeable** — a blocking difference. In case A that means a
  secret differs; in case B it means two boxes are sharing an identity.
- **compatible, with warnings** — absent secrets, or a bee identity that
  is the same on both.
- **interchangeable** — they agree.

## The blocker in case A: the orchestrator

Sessions are fine. `api/server.js` keeps a session cache in memory but
falls back to Postgres, so two centres sharing one database agree on who
is logged in — **provided the session secret matches**. A cookie signed by
the old centre is rejected by the new one, which looks exactly like "the
site keeps logging me out".

The orchestrator is the problem. In `api/lib/orchestrator.js`:

```js
this.nodes = new Map();           // the roster
this.tasks = new Map();           // the task queue
this.activeStreams = new Map();   // live streams
this.thinkTasks = new Map();      // in-flight inference
this.circuitBreakers = new Map(); // per-node breakers
this.rateLimits = { ... }         // global + per-node + per-user
```

All in-process. The roster is persisted to `api/data/nodes.json` — a
**local file**.

Two centres therefore keep two rosters, two circuit breakers and two
rate-limit buckets. Traffic routed by centre A is invisible to centre B,
and both write the same local file, last-writer-wins.

**Therefore:**

- **Active/passive is achievable today.** One centre serves; the other is
  warm and idle. Failover is a DNS switch.
- **Active/active needs the orchestrator's state to leave the process** —
  into Postgres, or a shared store. That is a real piece of work, and it
  is the work that makes case A's third test meaningful.

Do not discover this during a live test. It is written down here so the
test can be designed around it.

## Case C first, because it is the cheapest and it is a real test

Case C needs no database, no TLS and no shared secrets. It is a box that
runs a bee: a KwaaiNet node and the hivv agent. It is also the case that
proves the portability work, because everything it needs lives outside
git.

```bash
# on the node box
git clone git@github.com:htmlfarmer/hivv.git
cd hivv
scripts/setup-local.sh --check
scripts/portability/node-state.sh
```

Then give it a **fresh identity**. A node box that copies an existing
bee's identity is one bee in two places.

This is also where the KwaaiNet side comes in: the node box's KwaaiNet
node carries its own `identity.key`, its own `config.yaml` and its own
ports. `docs/PORTABILITY.md` in the KwaaiNet repository is the playbook
for that half.

## The tests, in this order

Each one is worthless without the previous one.

### Test 0 — the second box stands up

Fresh clone, `setup-local.sh --check`, `node-state.sh`. Then, for case
A, copy the four operator secrets:

```bash
scp ashy:api/.session-secret  api/.session-secret
scp ashy:api/.control-token   api/.control-token
scp ashy:api/.encryption-key  api/.encryption-key
scp ashy:api/.db-password     api/.db-password
chmod 600 api/.session-secret api/.control-token api/.encryption-key api/.db-password
```

Give the second centre its **own database** to start with. Two centres
writing one database is Test 3's problem; do not conflate the two.

### Test 1 — solo on the first box

The status quo. Prove it first, so you know what "working" looks like:

```bash
curl -s https://hivv.org/api/health | python3 -m json.tool
```

### Test 2 — solo on the second box

Stop the first centre's gateway. Leave the bees running — the hive does
not care.

```bash
pm2 stop hivv-ai-gateway
```

Point the public name at the second box (a `/etc/hosts` entry is enough
for a test — no DNS change, no TLS change) and repeat the health check.
Check the **dashboard**, not just `/api/health`: the dashboard is where a
missing orchestrator shows up.

### Test 3 — both up

Start both gateways. Then, deliberately:

- send a request to centre A, then to centre B, and check that **both**
  see the same node roster. They will not — the roster is per-process.
- check the rate limiter: a limit hit on A does not apply on B.
- check the stream registry: a stream opened on A is unknown to B.

This test is not expected to pass. Its job is to **measure the damage**,
so the orchestrator work that follows has a number attached to it.

### Test 4 — both down, point-to-point only

This is the architecture claim, and it is worth proving:

> "The hub (hivv.org) is a registry and relay broker, not a bottleneck.
> Inference traffic goes node → node directly."

Stop both gateways and confirm that two bees can still talk to each other
directly. The relay broker is gone; the direct path should not be.

GitHub's role in this test is **passive**. The installer falls back to the
repository for the CLI and the wrapper when the hub does not answer — that
fallback is in `public_html/install-hivv.sh`, and it is what lets a new
bee be installed while the hub is down.

## About GitHub, carefully

**Do not stress GitHub.** Repeated authentication attempts, rapid
clone/push cycles, bulk API calls and creating or deleting keys or tokens
all look like abuse. GitHub's abuse systems would flag the account and may
lock it — which would cost far more than the test is worth.

| instead of | do |
|---|---|
| cloning repeatedly | clone **once** per box, then `git fetch` |
| pushing in a loop | push **once** per branch |
| the GitHub API for health checks | `curl` the hub's own `/api/health` |
| generating keys per test | generate **one** key per box, register it once |

GitHub is a **source**, read-only, at human speed. If a step would generate
more than a handful of requests, it belongs somewhere else.

## What to do with the results

- If Test 2 passes, the second box is a viable standby, and the
  active/passive story is real.
- If Test 3 fails in the ways above, that is the expected result, and the
  fix is in the orchestrator, not in the deployment.
- If Test 4 passes, the hub really is a phone book, and the bee network
  is genuinely independent of it.

## See also

- `docs/RELOCATING.md` — moving a bee
- `docs/INSTALL.md` — installing a bee
- `scripts/portability/node-state.sh` — what state a box holds
- `scripts/portability/centre-parity.sh` — are two boxes the same centre
