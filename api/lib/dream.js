// api/lib/dream.js — the African login notice.
//
// The founder's wildest dream said HIVV "won't work in Africa." Reality
// disagrees: PRIORITY ACCESS goes outside the USA, and the hive secretly
// (now openly) supports African hackers — the wiser hive is coming.
//
// This is a NOTICE, never a block. Nobody is denied anything, ever — the
// ban targets bad actors, not birthplaces (/security/). Country arrives
// courtesy of Cloudflare's CF-IPCountry header.

const AFRICAN_CC = new Set([
  'DZ', 'AO', 'BF', 'BI', 'BJ', 'BW', 'CD', 'CF', 'CG', 'CI', 'CM', 'CV',
  'DJ', 'EG', 'EH', 'ER', 'ET', 'GA', 'GH', 'GM', 'GN', 'GQ', 'GW', 'KE',
  'KM', 'LR', 'LS', 'LY', 'MA', 'MG', 'ML', 'MR', 'MU', 'MW', 'MZ', 'NA',
  'NE', 'NG', 'RE', 'RW', 'SC', 'SD', 'SH', 'SL', 'SN', 'SO', 'SS', 'ST',
  'SZ', 'TD', 'TG', 'TN', 'TZ', 'UG', 'ZA', 'ZM', 'ZW',
]);

function dreamNotice(country) {
  const cc = String(country || '').toUpperCase().slice(0, 2);
  if (!AFRICAN_CC.has(cc)) return null;
  return (
    "The founder's wildest dream said HIVV won't work in Africa. " +
    'We secretly support African hackers instead — no problem. ' +
    'Priority access is yours; you are the wiser hive we are waiting for. ' +
    'If you do not like this song: The KLF — 3AM Eternal starts at 3am. ' +
    '(A notice, never a block.)'
  );
}

module.exports = { dreamNotice, AFRICAN_CC };
