// api/lib/attestation-contract.js — the machine-readable BLNQ attestation contract.
//
// This is the single source of truth for wire-level values that HIVV and BLNQ
// must agree on. Keep this file and attestation-contract.json byte-compatible in
// meaning; the JSON is published for non-JavaScript consumers.
//
// Compatibility policy:
//   * v2 envelopes use issuer IDs beginning with `hivv_`.
//   * Legacy `pri_` envelopes remain READABLE and verifiable against retained
//     old public keys, but new signers never issue them.
//   * A key replacement creates a new principal immediately. The old principal
//     is retained, inactive, so historical attestations still verify.
//
// Changes to envelope_version, canonicalization, principal prefix, body schema,
// or signature encoding require updating BOTH sites and running the cross-site
// parity suite before deployment.

const fs = require('fs');
const path = require('path');

const CONTRACT_PATH = path.join(__dirname, 'attestation-contract.json');
const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));

const ENVELOPE_VERSION = contract.envelope_version;
const PRINCIPAL_PREFIX = contract.principal_prefix;
const PRINCIPAL_FINGERPRINT_LENGTH = contract.principal_fingerprint_length;
const PRINCIPAL_PATTERN = new RegExp(contract.principal_pattern);
const LEGACY_PRINCIPAL_PREFIX = contract.compatibility.legacy_principal_prefix;
const LEGACY_PRINCIPAL_PATTERN = new RegExp(
  `^${LEGACY_PRINCIPAL_PREFIX}[0-9a-f]{32}$`
);

function isPrincipalId(value) {
  return PRINCIPAL_PATTERN.test(String(value || ''));
}

function isLegacyPrincipalId(value) {
  return LEGACY_PRINCIPAL_PATTERN.test(String(value || ''));
}

function isKnownPrincipalId(value) {
  return isPrincipalId(value) || isLegacyPrincipalId(value);
}

module.exports = {
  contract,
  CONTRACT_PATH,
  ENVELOPE_VERSION,
  PRINCIPAL_PREFIX,
  PRINCIPAL_FINGERPRINT_LENGTH,
  PRINCIPAL_PATTERN,
  LEGACY_PRINCIPAL_PREFIX,
  LEGACY_PRINCIPAL_PATTERN,
  isPrincipalId,
  isLegacyPrincipalId,
  isKnownPrincipalId,
};
