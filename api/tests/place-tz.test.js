'use strict';

// ── place → timezone, and the clock that must never lie ─────────────────────
//
// THE REPORTED BUG
// ----------------
//   $ hivv what time is it now in jinja uganda
//   → "The current time in Uganda is 2026-11-28 07:08:13 UTC."
//
// Uganda is UTC+03:00, so that answer was three hours wrong — and it looked
// authoritative. Three things caused it, and each one has a test below:
//
//   1. nothing could turn "Jinja, Uganda" into Africa/Kampala   → resolvePlace
//   2. current_time answered in UTC anyway and said ok:true      → Test A
//   3. no measured time was in the prompt to catch the mistake  → timeContext

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const placeTz = require('../lib/place-tz.js');
const toolkit = require('../lib/toolkit.js');

/** Call a tool handler directly — no policy gate, no server, no network. */
function handler(name) {
    const t = toolkit.TOOLS.find((x) => x.name === name);
    assert.ok(t, `tool '${name}' must exist in the catalog`);
    return t.handler;
}

// ── 1 · the place resolver ──────────────────────────────────────────────────

test('THE REPORTED BUG: "jinja uganda" resolves to Africa/Kampala', () => {
    const p = placeTz.resolvePlace('what time is it now in jinja uganda');
    assert.ok(p, 'the place must resolve');
    assert.strictEqual(p.zone, 'Africa/Kampala');
    assert.strictEqual(p.label, 'Jinja, Uganda');
    assert.strictEqual(p.source, 'city');
});

test('a bare city resolves, even one with no zone named after it', () => {
    // Jinja has no IANA zone of its own — without the curated entry this is
    // exactly the case that silently fell through to UTC.
    assert.strictEqual(placeTz.resolvePlace('jinja').zone, 'Africa/Kampala');
    assert.strictEqual(placeTz.resolvePlace('karachi').zone, 'Asia/Karachi');
    assert.strictEqual(placeTz.resolvePlace('dhaka').zone, 'Asia/Dhaka');
    assert.strictEqual(placeTz.resolvePlace('london').zone, 'Europe/London');
});

test('a country resolves to a real zone', () => {
    const expect = {
        uganda: 'Africa/Kampala', pakistan: 'Asia/Karachi',
        bangladesh: 'Asia/Dhaka', india: 'Asia/Kolkata',
        'south korea': 'Asia/Seoul', burma: 'Asia/Yangon',
        'united states': 'America/New_York'
    };
    for (const [q, zone] of Object.entries(expect)) {
        const p = placeTz.resolvePlace(`what time in ${q}`);
        assert.ok(p, `"${q}" must resolve`);
        assert.strictEqual(p.zone, zone, `"${q}"`);
    }
});

test('no place means no place — ordinary sentences never resolve', () => {
    // False positives here are worse than misses: a confidently wrong local
    // time is the very bug we are fixing.
    const none = [
        'tell us the time please',
        'what time does the center open',
        'what time is the male lion awake',   // 'male' is a word, not a place
        'is now a good time to read this',
        'what time is it',          // no place named at all
        'hello there'
    ];
    for (const q of none) {
        assert.strictEqual(placeTz.resolvePlace(q), null, `"${q}" must not resolve`);
    }
});

test('a longer phrase beats its own tail', () => {
    // "st petersburg" must not fall apart into America/Indiana/Petersburg.
    assert.strictEqual(placeTz.resolvePlace('what time in st petersburg').zone, 'Europe/Moscow');
    assert.strictEqual(placeTz.resolvePlace('what time in great britain').zone, 'Europe/London');
    assert.strictEqual(placeTz.resolvePlace('what time in south korea').zone, 'Asia/Seoul');
});

test('the destination of a journey is the place whose time you want', () => {
    assert.strictEqual(placeTz.resolvePlace('from london to paris what time').zone, 'Europe/Paris');
});

test('two-letter aliases only count when typed as acronyms', () => {
    assert.strictEqual(placeTz.resolvePlace('what time in US').zone, 'America/New_York');
    assert.strictEqual(placeTz.resolvePlace('what time in the USA').zone, 'America/New_York');
    // "tell us the time" is not a question about America.
    assert.strictEqual(placeTz.resolvePlace('tell us the time'), null);
});

test('an explicit IANA zone passes straight through', () => {
    const p = placeTz.resolvePlace('what time is it in Africa/Kampala');
    assert.strictEqual(p.zone, 'Africa/Kampala');
    assert.strictEqual(p.source, 'zone');
});

test('every curated and primary zone is one Intl accepts', () => {
    for (const [code, zone] of Object.entries(placeTz.PRIMARY_ZONE)) {
        assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }),
            `PRIMARY_ZONE.${code} = ${zone} must be a real IANA zone`);
    }
    for (const [city, zone] of Object.entries(placeTz.CURATED_CITY)) {
        assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }),
            `CURATED_CITY.${city} = ${zone} must be a real IANA zone`);
    }
});

test('the generated tzdata table is intact', () => {
    // Uganda is the country in the bug report — if the generated table ever
    // loses it, every Uganda question falls through to nothing.
    assert.ok(placeTz.COUNTRIES.UG, 'Uganda must be in the table');
    assert.deepStrictEqual(placeTz.COUNTRIES.UG.zones, ['Africa/Kampala']);
    assert.ok(placeTz.COUNTRIES.PK.zones.includes('Asia/Karachi'));
    for (const [code, info] of Object.entries(placeTz.COUNTRIES)) {
        assert.ok(Array.isArray(info.zones) && info.zones.length, `${code} has zones`);
        for (const z of info.zones) {
            assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: z }),
                `${code}: ${z} must be a real IANA zone`);
        }
    }
});

// ── 2 · the measured clock in the prompt ────────────────────────────────────

test('ordinary chat gets NO clock line (the prompt prefix must stay stable)', () => {
    // A system message that changes every second would rewrite the prompt
    // prefix and throw away the prefix cache — ~2,560 cached tokens on a
    // warm run. Only time questions pay that cost.
    assert.strictEqual(placeTz.timeContext('hello there'), null);
    assert.strictEqual(placeTz.timeContext('write me a poem about bees'), null);
    assert.strictEqual(placeTz.isTimeRelated('what time is it'), true);
    assert.strictEqual(placeTz.isTimeRelated('whats the date'), true);
});

test('the clock line states the measured UTC AND the resolved local time', () => {
    const now = new Date('2026-11-28T07:13:44Z');
    const ctx = placeTz.timeContext('what time is it now in jinja uganda', now);
    assert.ok(ctx, 'a time question must get a clock line');

    assert.ok(ctx.includes('2026-11-28 07:13:44'), 'must state the measured UTC time');
    assert.ok(ctx.includes('Africa/Kampala'), 'must name the resolved zone');
    assert.ok(ctx.includes('Jinja, Uganda'), 'must name the place');
    assert.ok(ctx.includes('UTC+03:00'), 'must state the offset');

    // The local time it hands the model must be the REAL local time.
    const local = placeTz.localNow(now, 'Africa/Kampala');
    assert.strictEqual(local.time, '10:13:44', 'Uganda is UTC+03:00');
    assert.ok(ctx.includes(local.time), 'the prompt must carry that local time');
    // Two instructions that each close a real hole we watched a model walk
    // through: it called a tool instead of reading the line, and it built a
    // zone name out of thin air ("Africa/Juno").
    assert.ok(/copied exactly/.test(ctx), 'must tell the model to read the line, not call a tool');
    assert.ok(/verbatim/.test(ctx), 'must say to COPY the zone, never construct one');
    // Hand it the zone's own abbreviation too, or it invents one: London came
    // back labelled "(CET)" while the time on the clock was right. Assert the
    // WIRING, not ICU's exact spelling — that differs by version/locale.
    assert.ok(local.zoneName, 'the zone abbreviation must be captured');
    assert.ok(ctx.includes(local.zoneName), 'the prompt must carry it so the model can copy it');
});

test('a time question with no place still gets the clock, and the rule', () => {
    const ctx = placeTz.timeContext('what time is it', new Date('2026-11-28T07:13:44Z'));
    assert.ok(ctx, 'must not be null');
    assert.ok(ctx.includes('2026-11-28 07:13:44'), 'must state UTC');
    // It must actively forbid the failure mode, not just supply a number.
    assert.ok(ctx.includes('UTC is not an answer'), 'must forbid labelling UTC as a place');
    // The tools accept place names now, so the model never has to guess a zone.
    assert.ok(ctx.includes('pass the PLACE name'), 'must tell the model the tools take place names');
});

// ── 3 · the tools must never answer in UTC for a zone they could not honour ─

test('current_time resolves a PLACE instead of quietly answering in UTC', async () => {
    const r = await handler('current_time')({ timezone: 'Uganda' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.timezone, 'Africa/Kampala');
    assert.strictEqual(r.data.utc_offset, '+03:00');
    assert.notStrictEqual(r.data.timezone, 'UTC', 'must never silently degrade to UTC');
    assert.strictEqual(r.data.resolved_from, 'Uganda', 'must say which place it translated');
});

test('current_time resolves the city in the bug report', async () => {
    const r = await handler('current_time')({ timezone: 'Jinja' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.timezone, 'Africa/Kampala');
    assert.strictEqual(r.data.utc_offset, '+03:00');
    assert.strictEqual(r.data.timezone_valid, true);
});

test('current_time REFUSES a timezone it cannot honour — no green UTC', async () => {
    // The old code returned ok:true with UTC and a buried timezone_valid:false.
    // That receipt is what let a model label a UTC value "Uganda".
    const r = await handler('current_time')({ timezone: 'Africa/Elon' });
    assert.strictEqual(r.ok, false, 'an unlocatable zone must not be reported as success');
    assert.ok(!r.data, 'there must be no data to misread');
    assert.match(r.error, /locate/i);
    assert.match(r.error, /Africa\/Kampala/, 'the error must show what a real zone looks like');
});

test('current_time with no argument still means UTC — that is the documented default', async () => {
    const r = await handler('current_time')({});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.timezone, 'UTC');
});

test('timezone_convert accepts a PLACE for both ends', async () => {
    const r = await handler('timezone_convert')({ timezone: 'Uganda', from_timezone: 'Pakistan' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.timezone, 'Africa/Kampala');
    assert.strictEqual(r.data.from_timezone, 'Asia/Karachi');
    assert.ok(r.data.difference, 'must report the difference between the two');
    assert.strictEqual(r.data.resolved_from, 'Uganda');
});

test('datetime:"now" is HONOURED — the intent is unambiguous', async () => {
    // The exact slip from the original report: a model passed datetime:"now",
    // got a refusal, apologised, invented a reason, and answered from memory.
    // "now" means now — honour it instead of spending a round trip teaching
    // a small model to reword its call.
    const r = await handler('timezone_convert')({ timezone: 'Africa/Kampala', datetime: 'now' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.timezone, 'Africa/Kampala');
    assert.strictEqual(r.data.is_now, true);
    assert.ok(Math.abs(Date.now() - new Date(r.data.source_datetime).getTime()) < 60000,
        'datetime:"now" must mean the current moment');
});

test('a genuinely unparseable datetime still gets a repair instruction', async () => {
    const r = await handler('timezone_convert')({ timezone: 'Africa/Kampala', datetime: 'half past tuesday' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /OMIT the datetime/i, 'must say to drop the argument');
    assert.match(r.error, /ISO-8601/, 'must show the format that does work');
});

test('a bad from_timezone never destroys the target answer', async () => {
    // Observed live: a model passed from_timezone:"now", the WHOLE call
    // failed, and it then invented a time for London out of thin air. An
    // optional argument must not be able to take the answer down with it.
    const r = await handler('timezone_convert')({ timezone: 'London', from_timezone: 'now' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.data.timezone, 'Europe/London');
    assert.strictEqual(r.data.utc_offset, '+00:00');
    assert.ok(r.data.from_timezone_error, 'the bad argument must still be reported');
    assert.match(r.data.from_timezone_error, /OMIT it/, 'with a repair instruction');
    assert.match(r.data.from_timezone_error, /from_timezone is only for/, 'and say what the argument is FOR');
});
test('timezone_convert refuses an unlocatable zone rather than guessing', async () => {
    const r = await handler('timezone_convert')({ timezone: 'Africa/Elon' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /locate/i);
});

// ── 4 · the wiring ──────────────────────────────────────────────────────────

test('server.js injects the measured clock at every briefing site', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const def = (src.match(/function timeSystemMessages\(/g) || []).length;
    const calls = (src.match(/timeSystemMessages\(/g) || []).length;
    assert.strictEqual(calls - def, 4,
        'expected the clock at all four message-list sites (v1, chat, chat-stream, continue)');
    // The clock is only useful where the toolkit is attached — an opted-out
    // client asked us not to augment its prompt.
    assert.strictEqual((src.match(/toolsAttached \? \[toolSystemMessage\(effectiveTools\), \.\.\.timeSystemMessages\(messages\)\]/g) || []).length, 4,
        'every site must gate the clock behind toolsAttached, exactly like the briefing');
});

test('the briefing itself is untouched — the clock is a separate message', () => {
    // The full-set briefing is pinned byte-identical elsewhere; adding the
    // clock to it would silently change every prompt's shape.
    const b = toolkit.toolBriefing(null);
    assert.ok(!/MEASURED CLOCK/.test(b), 'the briefing must not carry the clock');
});

// ── 5 · the generator stays honest ──────────────────────────────────────────

// The inputs are VENDORED (scripts/tzdata/), so this check no longer
// depends on the runner having tzdata installed — and, crucially, no longer
// depends on the runner's tzdata MATCHING the generator's. It used to read
// /usr/share/zoneinfo and byte-compare, so any box with a different tzdata
// version died with exit 2: that is what red-lit this test on BOTH ubuntu
// and macos runners (2026-11-28) for data that was never wrong.
const SNAPSHOT = path.join(__dirname, '..', '..', 'scripts', 'tzdata', 'zone.tab');
const ZONE_TAB = process.env.HIVV_ZONE_TAB || SNAPSHOT;
const canRegenerate = fs.existsSync(ZONE_TAB)
    && spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

test('the generated data module matches the system tzdata',
    { skip: canRegenerate ? false : 'tzdata/python3 not present on this machine' }, () => {
        const repo = path.join(__dirname, '..', '..');
        const r = spawnSync('python3', [path.join(repo, 'scripts', 'gen-place-tz.py'), '--check'], {
            encoding: 'utf8', cwd: repo
        });
        assert.strictEqual(r.status, 0,
            `place-tz-data.js is out of date — run scripts/gen-place-tz.py\n${r.stderr || ''}`);
    });
