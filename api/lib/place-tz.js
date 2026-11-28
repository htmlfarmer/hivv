'use strict';

// ── place → IANA timezone ───────────────────────────────────────────────────
//
// THE BUG THIS EXISTS TO FIX
// --------------------------
//   $ hivv what time is it now in jinja uganda
//   → "The current time in Uganda is 2026-11-28 07:08:13 UTC."
//
// Uganda is UTC+03:00. The answer was UTC, labelled as Uganda — three hours
// wrong, and it looked authoritative.
//
// It happened because THREE small things lined up:
//
//   1. The model has to turn "Jinja, Uganda" into an IANA zone all by itself.
//      A 0.5B model knows "karachi" → Asia/Karachi (it did) but not "jinja"
//      → Africa/Kampala (it did not), so it passed NO timezone at all.
//   2. `current_time` treats "no timezone" and "an invalid timezone" the same
//      way: it silently answers in UTC and reports ok:true.
//   3. Nothing measured was in the prompt, so the model had no ground truth
//      to catch its own mistake with — it just labelled the UTC value with
//      the place the user asked for.
//
// This module fixes (1): the HUB resolves the place, using the canonical
// IANA country/zone tables (see scripts/gen-place-tz.py for why those are
// generated rather than typed). server.js then puts the measured local time
// in the prompt (fixes 3), and toolkit.js refuses to answer an unrecognised
// timezone with a quiet UTC (fixes 2).
//
// Nothing here talks to the network or the database — it is a pure function
// of (text, the system clock), so it is safe on every request.

const DATA = require('./place-tz-data.js');
const { COUNTRIES, ZONE_CITY, ZONES } = DATA;

// ── judgement, not data ─────────────────────────────────────────────────────
//
// tzdata names countries the way paperwork does ("Russian Federation",
// "Korea (South)", "Myanmar (Burma)"). People type "russia", "south korea",
// "burma". These are the bridge.

const COUNTRY_ALIAS = {
    // Anglosphere spellings
    'usa': 'US', 'us': 'US', 'united states': 'US', 'united states of america': 'US',
    'uk': 'GB', 'united kingdom': 'GB', 'britain': 'GB', 'great britain': 'GB',
    'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB',
    'holland': 'NL',
    // Common names that differ from the ISO short form
    'russia': 'RU', 'south korea': 'KR', 'north korea': 'KP', 'korea': 'KR',
    'uae': 'AE', 'emirates': 'AE', 'czech republic': 'CZ', 'czechia': 'CZ',
    'turkey': 'TR', 'turkiye': 'TR', 'burma': 'MM', 'macedonia': 'MK',
    'swaziland': 'SZ', 'cape verde': 'CV', 'cabo verde': 'CV', 'east timor': 'TL',
    'timor leste': 'TL', 'ivory coast': 'CI', 'cote divoire': 'CI',
    'drc': 'CD', 'dr congo': 'CD', 'democratic republic of the congo': 'CD',
    'democratic republic of congo': 'CD', 'congo': 'CG', 'republic of the congo': 'CG',
    'iran': 'IR', 'syria': 'SY', 'laos': 'LA', 'bolivia': 'BO', 'venezuela': 'VE',
    'tanzania': 'TZ', 'moldova': 'MD', 'vietnam': 'VN', 'viet nam': 'VN',
    'brunei': 'BN', 'micronesia': 'FM', 'south sudan': 'SS', 'palestine': 'PS',
    'west bank': 'PS', 'gaza strip': 'PS', 'saudi': 'SA', 'sri lanka': 'LK',
    'south africa': 'ZA', 'new zealand': 'NZ', 'costa rica': 'CR',
    'dominican republic': 'DO', 'el salvador': 'SV', 'north macedonia': 'MK',
    'central african republic': 'CF', 'equatorial guinea': 'GQ',
    'bosnia': 'BA', 'herzegovina': 'BA', 'sao tome': 'ST', 'st thomas': 'ST',
    'antigua': 'AG', 'barbados': 'BB', 'trinidad': 'TT', 'tobago': 'TT',
    'the gambia': 'GM', 'gambia': 'GM', 'the bahamas': 'BS', 'bahamas': 'BS',
    'united arab emirates': 'AE', 'myanmar': 'MM', 'eswatini': 'SZ',
    'republic of korea': 'KR', 'dem republic congo': 'CD',
    'principe': 'ST', 'curacao': 'CW', 'reunion': 'RE', 'hong kong': 'HK',
    'macao': 'MO', 'puerto rico': 'PR', 'greenland': 'GL', 'faroe islands': 'FO',
    'isle of man': 'IM', 'jersey': 'JE', 'guernsey': 'GG', 'gibraltar': 'GI',
    'virgin islands': 'VI', 'cayman islands': 'KY', 'turks and caicos': 'TC',
    'falkland islands': 'FK', 'wester sahara': 'EH', 'western sahara': 'EH',
    'sandwich': 'GS', 'borneo': 'ID', 'java': 'ID', 'sumatra': 'ID',
    'bali': 'ID', 'kalimantan': 'ID', 'sulawesi': 'ID'
};

// Countries whose city keys are too generic to trust as a place on their own.
// These are almost all US townships and Antarctic stations: nobody asking
// "what time does the center open?" means America/North_Dakota/Center, and
// "st petersburg" must never resolve to America/Indiana/Petersburg.
const CITY_BLOCKLIST = new Set([
    'center', 'new_salem', 'beulah', 'vincennes', 'winamac', 'marengo',
    'petersburg', 'vevay', 'tell_city', 'knox', 'monticello', 'menominee',
    'metlakatla', 'busingen', 'casey', 'davis', 'resolute', 'regina',
    'chatham', 'cambridge_bay', 'rankin_inlet', 'iqaluit', 'resolute',
    'lower_princes', 'blanc_sablon', 'glace_bay', 'goose_bay', 'swift_current',
    'whitehorse', 'creston', 'nukualofa'
]);

// The zone a bare country name should answer with when it spans several.
// 31 countries span more than one zone — the US has 29, Russia 26. Saying
// "it is 10:00 in the USA" without naming WHICH zone is its own kind of lie,
// so we always name the zone we used.
const PRIMARY_ZONE = {
    AQ: 'Antarctica/Troll', AR: 'America/Argentina/Buenos_Aires',
    AU: 'Australia/Sydney', BR: 'America/Sao_Paulo', CA: 'America/Toronto',
    CD: 'Africa/Kinshasa', CL: 'America/Santiago', CN: 'Asia/Shanghai',
    CY: 'Asia/Nicosia', DE: 'Europe/Berlin', EC: 'America/Guayaquil',
    ES: 'Europe/Madrid', FM: 'Pacific/Chuuk', GL: 'America/Nuuk',
    ID: 'Asia/Jakarta', KI: 'Pacific/Tarawa', KZ: 'Asia/Almaty',
    MH: 'Pacific/Majuro', MN: 'Asia/Ulaanbaatar', MX: 'America/Mexico_City',
    MY: 'Asia/Kuala_Lumpur', NZ: 'Pacific/Auckland', PF: 'Pacific/Tahiti',
    PG: 'Pacific/Port_Moresby', PS: 'Asia/Hebron', PT: 'Europe/Lisbon',
    RU: 'Europe/Moscow', UA: 'Europe/Kyiv', UM: 'Pacific/Midway',
    US: 'America/New_York', UZ: 'Asia/Tashkent'
};

// Cities the tz tables do not name a zone after, but that people ask about.
// Jinja is here because it is the city in the bug report above: it has no
// zone of its own, so without this entry "jinja" alone resolves to nothing.
const CURATED_CITY = {
    'jinja': 'Africa/Kampala', 'entebbe': 'Africa/Kampala', 'gulu': 'Africa/Kampala',
    'mbarara': 'Africa/Kampala', 'mombasa': 'Africa/Nairobi', 'kisumu': 'Africa/Nairobi',
    'nakuru': 'Africa/Nairobi', 'arusha': 'Africa/Dar_es_Salaam',
    'zanzibar': 'Africa/Dar_es_Salaam',
    'lahore': 'Asia/Karachi', 'islamabad': 'Asia/Karachi', 'faisalabad': 'Asia/Karachi',
    'peshawar': 'Asia/Karachi', 'quetta': 'Asia/Karachi', 'multan': 'Asia/Karachi',
    'rawalpindi': 'Asia/Karachi',
    'delhi': 'Asia/Kolkata', 'mumbai': 'Asia/Kolkata', 'bangalore': 'Asia/Kolkata',
    'bengaluru': 'Asia/Kolkata', 'chennai': 'Asia/Kolkata', 'kolkata': 'Asia/Kolkata',
    'ahmedabad': 'Asia/Kolkata', 'pune': 'Asia/Kolkata', 'jaipur': 'Asia/Kolkata',
    'lucknow': 'Asia/Kolkata', 'surat': 'Asia/Kolkata', 'nagpur': 'Asia/Kolkata',
    'dhaka': 'Asia/Dhaka', 'chittagong': 'Asia/Dhaka', 'chattogram': 'Asia/Dhaka',
    'sylhet': 'Asia/Dhaka', 'khulna': 'Asia/Dhaka', 'rajshahi': 'Asia/Dhaka',
    'jakarta': 'Asia/Jakarta', 'surabaya': 'Asia/Jakarta', 'bandung': 'Asia/Jakarta',
    'medan': 'Asia/Jakarta', 'semarang': 'Asia/Jakarta', 'yogyakarta': 'Asia/Jakarta',
    'makassar': 'Asia/Makassar', 'denpasar': 'Asia/Makassar', 'balikpapan': 'Asia/Makassar',
    'jayapura': 'Asia/Jayapura', 'manado': 'Asia/Makassar',
    'dubai': 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', 'sharjah': 'Asia/Dubai',
    'doha': 'Asia/Qatar', 'riyadh': 'Asia/Riyadh', 'jeddah': 'Asia/Riyadh',
    'mecca': 'Asia/Riyadh', 'medina': 'Asia/Riyadh', 'kuwait city': 'Asia/Kuwait',
    'manama': 'Asia/Bahrain', 'muscat': 'Asia/Muscat', 'cairo': 'Africa/Cairo',
    'alexandria': 'Africa/Cairo', 'lagos': 'Africa/Lagos', 'accra': 'Africa/Accra',
    'nairobi': 'Africa/Nairobi', 'addis ababa': 'Africa/Addis_Ababa',
    'kigali': 'Africa/Kigali', 'dar es salaam': 'Africa/Dar_es_Salaam',
    'kampala': 'Africa/Kampala', 'khartoum': 'Africa/Khartoum',
    'johannesburg': 'Africa/Johannesburg', 'cape town': 'Africa/Johannesburg',
    'durban': 'Africa/Johannesburg', 'pretoria': 'Africa/Johannesburg',
    'casablanca': 'Africa/Casablanca', 'tunis': 'Africa/Tunis',
    'algiers': 'Africa/Algiers', 'tripoli': 'Africa/Tripoli',
    'london': 'Europe/London', 'manchester': 'Europe/London',
    'edinburgh': 'Europe/London',
    'glasgow': 'Europe/London', 'dublin': 'Europe/Dublin',
    'paris': 'Europe/Paris', 'lyon': 'Europe/Paris', 'marseille': 'Europe/Paris',
    'berlin': 'Europe/Berlin', 'munich': 'Europe/Berlin',
    'hamburg': 'Europe/Berlin', 'frankfurt': 'Europe/Berlin', 'cologne': 'Europe/Berlin',
    'madrid': 'Europe/Madrid', 'barcelona': 'Europe/Madrid',
    'rome': 'Europe/Rome', 'milan': 'Europe/Rome',
    'naples': 'Europe/Rome', 'turin': 'Europe/Rome', 'venice': 'Europe/Rome',
    'amsterdam': 'Europe/Amsterdam', 'rotterdam': 'Europe/Amsterdam',
    'brussels': 'Europe/Brussels', 'zurich': 'Europe/Zurich', 'geneva': 'Europe/Zurich',
    'bern': 'Europe/Zurich', 'vienna': 'Europe/Vienna', 'prague': 'Europe/Prague',
    'warsaw': 'Europe/Warsaw', 'krakow': 'Europe/Warsaw', 'budapest': 'Europe/Budapest',
    'athens': 'Europe/Athens', 'istanbul': 'Europe/Istanbul', 'ankara': 'Europe/Istanbul',
    'kyiv': 'Europe/Kyiv', 'kharkiv': 'Europe/Kyiv', 'odesa': 'Europe/Kyiv',
    'moscow': 'Europe/Moscow', 'saint petersburg': 'Europe/Moscow',
    'st petersburg': 'Europe/Moscow', 'novosibirsk': 'Asia/Novosibirsk',
    'yekaterinburg': 'Asia/Yekaterinburg', 'vladivostok': 'Asia/Vladivostok',
    'stockholm': 'Europe/Stockholm', 'oslo': 'Europe/Oslo',
    'copenhagen': 'Europe/Copenhagen', 'helsinki': 'Europe/Helsinki',
    'reykjavik': 'Atlantic/Reykjavik', 'lisbon': 'Europe/Lisbon',
    'porto': 'Europe/Lisbon', 'kyoto': 'Asia/Tokyo', 'osaka': 'Asia/Tokyo',
    'nagoya': 'Asia/Tokyo', 'sapporo': 'Asia/Tokyo', 'seoul': 'Asia/Seoul',
    'busan': 'Asia/Seoul', 'beijing': 'Asia/Shanghai', 'shanghai': 'Asia/Shanghai',
    'shenzhen': 'Asia/Shanghai', 'guangzhou': 'Asia/Shanghai', 'chengdu': 'Asia/Shanghai',
    'hong kong': 'Asia/Hong_Kong', 'taipei': 'Asia/Taipei',
    'manila': 'Asia/Manila', 'cebu': 'Asia/Manila', 'bangkok': 'Asia/Bangkok',
    'phnom penh': 'Asia/Phnom_Penh', 'hanoi': 'Asia/Ho_Chi_Minh',
    'ho chi minh city': 'Asia/Ho_Chi_Minh', 'saigon': 'Asia/Ho_Chi_Minh',
    'kuala lumpur': 'Asia/Kuala_Lumpur', 'penang': 'Asia/Kuala_Lumpur',
    'singapore': 'Asia/Singapore', 'yangon': 'Asia/Yangon', 'naypyidaw': 'Asia/Yangon',
    'kathmandu': 'Asia/Kathmandu', 'colombo': 'Asia/Colombo',
    'kandy': 'Asia/Colombo',
    'new york': 'America/New_York',
    'los angeles': 'America/Los_Angeles', 'chicago': 'America/Chicago',
    'houston': 'America/Chicago', 'dallas': 'America/Chicago',
    'san francisco': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles',
    'denver': 'America/Denver', 'phoenix': 'America/Phoenix',
    'atlanta': 'America/New_York', 'miami': 'America/New_York',
    'boston': 'America/New_York', 'washington': 'America/New_York',
    'detroit': 'America/Detroit', 'austin': 'America/Chicago',
    'toronto': 'America/Toronto', 'montreal': 'America/Toronto',
    'vancouver': 'America/Vancouver', 'calgary': 'America/Edmonton',
    'mexico city': 'America/Mexico_City', 'guadalajara': 'America/Mexico_City',
    'monterrey': 'America/Mexico_City', 'cancun': 'America/Cancun',
    'bogota': 'America/Bogota',
    'santiago': 'America/Santiago', 'buenos aires': 'America/Argentina/Buenos_Aires',
    'rio de janeiro': 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo',
    'brasilia': 'America/Sao_Paulo', 'caracas': 'America/Caracas',
    'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne',
    'brisbane': 'Australia/Brisbane', 'perth': 'Australia/Perth',
    'adelaide': 'Australia/Adelaide', 'canberra': 'Australia/Sydney',
    'auckland': 'Pacific/Auckland', 'wellington': 'Pacific/Auckland',
    'suva': 'Pacific/Fiji', 'port moresby': 'Pacific/Port_Moresby',
    'tel aviv': 'Asia/Jerusalem', 'jerusalem': 'Asia/Jerusalem',
    'haifa': 'Asia/Jerusalem', 'beirut': 'Asia/Beirut', 'damascus': 'Asia/Damascus',
    'amman': 'Asia/Amman', 'baghdad': 'Asia/Baghdad', 'tehran': 'Asia/Tehran',
    'kabul': 'Asia/Kabul'
};

// ── normalisation ───────────────────────────────────────────────────────────

/** Lower-case, strip accents, collapse every separator to a single space. */
function normalize(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

// Phrase tables are built ONCE, at load, sorted longest-first so
// "united states" beats "states" and "st petersburg" beats "petersburg".

const CITY_PHRASES = (() => {
    const list = [];
    for (const [city, zone] of Object.entries(CURATED_CITY)) {
        if (CITY_BLOCKLIST.has(city)) {continue;}
        list.push({ phrase: normalize(city), zone, curated: true });
    }
    for (const [city, zone] of Object.entries(ZONE_CITY)) {
        if (CITY_BLOCKLIST.has(city)) {continue;}
        // A curated entry wins — "kampala" should not be shadowed by anything.
        list.push({ phrase: normalize(city), zone, curated: false });
    }
    list.sort((a, b) => b.phrase.length - a.phrase.length);
    return list;
})();

const COUNTRY_PHRASES = (() => {
    const list = [];
    for (const [alias, code] of Object.entries(COUNTRY_ALIAS)) {
        const c = COUNTRIES[code];
        if (!c) {continue;}
        list.push({ phrase: normalize(alias), code });
    }
    for (const [code, c] of Object.entries(COUNTRIES)) {
        list.push({ phrase: normalize(c.name), code });
    }
    list.sort((a, b) => b.phrase.length - a.phrase.length);
    return list;
})();

// zone → country code, so a city can be labelled with its country.
const ZONE_COUNTRY = (() => {
    const m = new Map();
    for (const [code, c] of Object.entries(COUNTRIES)) {
        for (const z of c.zones) {if (!m.has(z)) {m.set(z, code);}}
    }
    return m;
})();

/** Every country phrase is matched as a whole word — "in" must not hit "India". */
function findPhrase(haystack, phrases, allowShortUppercase) {
    const hits = [];
    for (const entry of phrases) {
        const needle = ` ${entry.phrase} `;
        const idx = haystack.lastIndexOf(needle);
        if (idx === -1) {continue;}
        if (entry.phrase.length <= 2 && allowShortUppercase) {
            // Two-letter aliases ("us", "uk") only count when the user typed
            // them as an acronym. "tell us the time" is not a question about
            // America.
            if (!hasUppercaseAcronym(entry.phrase)) {continue;}
        }
        hits.push({ ...entry, idx, end: idx + needle.length });
    }
    if (!hits.length) {return null;}

    // A phrase sitting INSIDE a longer one is the tail of that phrase —
    // "petersburg" inside "st petersburg", "britain" inside "great britain" —
    // and must never win on its own.
    const strict = (a, b) => a.idx >= b.idx && a.end <= b.end
        && (a.idx > b.idx || a.end < b.end);
    const kept = hits.filter((h) => !hits.some((o) => o !== h && strict(h, o)));
    const pool = kept.length ? kept : hits;

    // Among what is left, the RIGHTMOST mention wins: in "from london to
    // paris" the destination is the place whose time you are asking for.
    pool.sort((a, b) => (b.idx - a.idx) || (b.phrase.length - a.phrase.length));
    return pool[0];
}

const ACRONYM_CACHE = new Map();
function hasUppercaseAcronym(word) {
    if (ACRONYM_CACHE.has(word)) {return ACRONYM_CACHE.get(word);}
    const re = new RegExp(`\\b${word.toUpperCase()}\\b`);
    const hit = re.test(String(lastRawText || ''));
    ACRONYM_CACHE.set(word, hit);
    return hit;
}

// Raw text of the request currently being resolved, so the acronym check can
// look at how the user actually capitalised it. Set by resolvePlace().
let lastRawText = '';

/** The explicit IANA zone written in the text, if any: "Africa/Karachi". */
function findExplicitZone(text) {
    const m = String(text).match(/\b([A-Za-z]{3,}(?:\/[A-Za-z_]+){1,2})\b/);
    if (!m) {return null;}
    const zone = ZONES.find((z) => z.toLowerCase() === m[1].toLowerCase());
    return zone || null;
}

/**
 * Turn free text into an IANA timezone.
 *
 * Specificity order — most specific wins, because it is the most likely
 * intent: an explicit zone beats a city, a city beats a country.
 *
 * @returns {{zone, label, source, code, zones}|null}
 *   source: 'zone' | 'city' | 'country'
 */
function resolvePlace(text) {
    lastRawText = String(text ?? '');
    ACRONYM_CACHE.clear();
    const raw = lastRawText;
    if (!raw.trim()) {return null;}

    // 1 — the user named a zone outright.
    const zone = findExplicitZone(raw);
    if (zone) {
        const code = ZONE_COUNTRY.get(zone) || null;
        return { zone, label: zone, source: 'zone', code, zones: null };
    }

    const norm = ` ${normalize(raw)} `;
    if (norm === '  ') {return null;}

    // 2 — a city (curated first: Jinja has no zone named after it).
    const city = findPhrase(norm, CITY_PHRASES, true);
    if (city) {
        return describe(city.zone, 'city', cityLabel(city.zone, city.phrase));
    }

    // 3 — a country.
    const country = findPhrase(norm, COUNTRY_PHRASES, true);
    if (country) {
        const info = COUNTRIES[country.code];
        const zones = info ? info.zones : [];
        const primary = PRIMARY_ZONE[country.code] || zones[0] || null;
        if (!primary) {return null;}
        const name = countryName(country.code);
        return {
            zone: primary,
            label: name,
            source: 'country',
            code: country.code,
            zones: zones.length > 1 ? zones : null
        };
    }
    return null;
}

// tzdata's own short forms are paperwork, not prose: "Britain (UK)",
// "Korea (South)", "Myanmar (Burma)". These read naturally in an answer.
const COUNTRY_LABEL = {
    GB: 'United Kingdom', KR: 'South Korea', KP: 'North Korea',
    MM: 'Myanmar', CD: 'DR Congo', CG: 'Republic of the Congo',
    SZ: 'Eswatini', MK: 'North Macedonia', TL: 'East Timor',
    CI: "Côte d'Ivoire", CV: 'Cape Verde', FM: 'Micronesia',
    IR: 'Iran', LA: 'Laos', MD: 'Moldova'
};

function countryName(code) {
    const info = COUNTRIES[code];
    if (!info) {return code;}
    return COUNTRY_LABEL[code] || info.name;
}

function cityLabel(zone, cityPhrase) {
    const code = ZONE_COUNTRY.get(zone);
    const country = code ? countryName(code) : null;
    const title = cityPhrase.replace(/\b\w/g, (c) => c.toUpperCase());
    return country ? `${title}, ${country}` : title;
}

function describe(zone, source, label) {
    const code = ZONE_COUNTRY.get(zone) || null;
    return { zone, label, source, code, zones: null };
}

// ── the measured clock ──────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _parts(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'long',
        // The zone's own abbreviation (EAT, GMT, PKT). Without it a model
        // invents one — London came back labelled "(CET)" while the time on
        // the clock was perfectly right.
        timeZoneName: 'short'
    });
    const out = {};
    for (const p of fmt.formatToParts(date)) {out[p.type] = p.value;}
    return out;
}

function offsetMinutes(date, tz) {
    const p = _parts(date, tz);
    const asUtc = Date.UTC(
        parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10),
        parseInt(p.hour, 10) % 24, parseInt(p.minute, 10), parseInt(p.second, 10));
    return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

function formatOffset(min) {
    const sign = min < 0 ? '-' : '+';
    const a = Math.abs(min);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** Wall-clock in a zone: "2026-11-28 10:13:44", plus weekday and offset. */
function localNow(date, tz) {
    const p = _parts(date, tz);
    return {
        date: `${p.year}-${p.month}-${p.day}`,
        time: `${p.hour}:${p.minute}:${p.second}`,
        weekday: p.weekday || WEEKDAYS[date.getUTCDay()],
        offset: formatOffset(offsetMinutes(date, tz)),
        zoneName: p.timeZoneName || null
    };
}

// ── time intent ─────────────────────────────────────────────────────────────
//
// The measured clock goes into the prompt ONLY for questions about time.
// Putting it on every request would rewrite the system message every second
// and destroy the prefix cache (a warm run reports ~2,560 cached prompt
// tokens; a cold one recomputes all of them).

const TIME_RE = new RegExp(
    '\\b(?:time|times|hour|hours|minute|minutes|clock|watch|timezone|time\\s+zone|tz|'
    + 'midnight|noon|o\\s*clock|today|tomorrow|yesterday|tonight|date|dates|'
    + 'dst|daylight|utc|gmt|am|pm|sunrise|sunset|weekday|weekdays|'
    + 'day\\s+of\\s+(?:the\\s+)?week|calendar|elapsed|duration)\\b',
    'i');

function isTimeRelated(text) {
    return TIME_RE.test(String(text ?? ''));
}

/**
 * The system-message text that stops a model from inventing a timezone.
 *
 * Returns null for anything that is not about time, so ordinary chat keeps a
 * byte-stable prefix (and its prompt cache).
 *
 * @param {string} text — the user's message
 * @param {Date} [now]
 */
function timeContext(text, now) {
    const raw = String(text ?? '');
    if (!isTimeRelated(raw)) {
        return null;
    }

    const at = now || new Date();
    const utc = localNow(at, 'UTC');
    const head = [
        'MEASURED CLOCK — trust this over your own memory; it comes from the hub\'s clock, not a guess.',
        `now (UTC): ${utc.date} ${utc.time} (${utc.weekday}).`
    ];

    const place = resolvePlace(raw);
    if (place) {
        const local = localNow(at, place.zone);
        const zoneName = local.zoneName ? `, ${local.zoneName}` : '';
        let line = `The place in this question resolves to ${place.zone} — ${place.label} (UTC${local.offset})`
            + ` → local now: ${local.date} ${local.time} (${local.weekday}${zoneName}).`;
        if (place.zones && place.zones.length > 1) {
            line += ` ${place.label} spans ${place.zones.length} zones; ${place.zone} is the one to quote here.`;
        }
        head.push(line);
        // Say COPY, not "this is what a zone looks like": showing the model
        // an example zone invites it to construct one by pattern — which is
        // exactly how a question about Uganda came back citing "Africa/Juno".
        head.push('Answer with the LOCAL time above, copied exactly — no tool call is needed for the current time. Never label a UTC value with a place\'s name, and never construct an IANA zone name: use the zone written above verbatim.');
    } else {
        head.push('If this question names a place, answer with THAT place\'s local time: pass the PLACE name to current_time or timezone_convert and the hive resolves the zone for you. UTC is not an answer to "what time is it in X", and never invent an IANA zone name.');
    }
    return head.join(' ');
}

module.exports = {
    resolvePlace,
    isTimeRelated,
    timeContext,
    localNow,
    formatOffset,
    offsetMinutes,
    normalize,
    COUNTRIES,
    ZONE_CITY,
    ZONES,
    PRIMARY_ZONE,
    COUNTRY_ALIAS,
    CURATED_CITY
};
