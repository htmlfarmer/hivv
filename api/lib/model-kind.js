// api/lib/model-kind.js — ONE definition of "what kind of model is this".
//
// WHY A SEPARATE MODULE: two surfaces already needed this predicate — the
// router (which candidates may be offered) and capabilities (which may be
// CLAIMED for a bee). Duplicating the family list in each is exactly how the
// CLI and the hub would drift apart, so the list lives here once and both
// require it. api/tests/embed-model.test.js pins the hub's copy against the
// CLI's `_EMBED_NAME_HINTS`.
//
// THE BUG THAT MOTIVATED IT (ashy, 2026-11-28): nomic-embed-text:latest was
// offered as a chat candidate, answered HTTP 400 "does not support chat", and
// the hint beneath it blamed slot config.

// Embedding families. Matched as substrings against a lower-cased name.
// No chat model ships "embed" in its tag, so this cannot take a real answer
// away; bge-/all-minilm/gte-/sentence-transformers are embedders by
// construction and carry no 'embed' substring of their own.
const EMBED_MODEL_RE = /embed|bge-|all-minilm|sentence-transformers|gte-/i;

// An embedder turns text into vectors. It can never answer a chat.
// A name we cannot identify is NOT an embedder: unknown stays eligible, so a
// model this list has never heard of is never silently dropped.
function isEmbedModel(name) {
  return EMBED_MODEL_RE.test(String(name || ''));
}

// The models on a heartbeat entry list that could actually answer a chat.
// Reads BOTH keys: heartbeats carry `model` (`_detect_local_ai`) while some
// fixtures use `name`.
function chatModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter(m => m && !isEmbedModel(m.model || m.name));
}

// True when a bee has at least one model that could answer a chat. This is
// the gate capabilities uses: a bee running ONLY embedders has no reasoning,
// coding or translation to offer, whatever else it advertises.
function hasChatModel(models) {
  return chatModels(models).length > 0;
}

module.exports = { EMBED_MODEL_RE, isEmbedModel, chatModels, hasChatModel };
