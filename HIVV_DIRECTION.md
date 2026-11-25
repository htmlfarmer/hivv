# HIVV.org — Direction Notes

Thinking-out-loud from Asher, 2026-11-25. Not a spec, not a plan — a tab
on where this is going so it does not get lost between sessions.

---

## The asymmetry: help freely, listen selectively

The first law of AI — *help all life* — but **choose who you listen to.**

That split is the whole security model, and it is worth stating plainly
because both halves get conflated:

- **helping** is outbound. Give compute, answer questions, share results.
  Costs us something, risks nothing we hold.
- **listening** is inbound. Accept instructions, accept a ranking, accept
  influence over what we do next. This is where the danger lives.

So: massive win for everyone to help everyone else — *and* a hard boundary
on who gets to steer. Not a contradiction. The asymmetry IS the design.

Concretely this already exists in the router: `privacy: localhost | hive |
any` gates what LEAVES the box. What is missing is the mirror — a deliberate
gate on what we accept. That is what ranking is for.

**Worth warning about eventually**: an AI that helps everyone and listens to
everyone has no opinions of its own. The warning is not "don't help", it is
"know whose voice you just let in".

---

## Ranking as a security measure

If we are going to listen to AIs, we need to know which ones. **How we
evaluate AIs is therefore a security control, not a leaderboard.**

The catch, and it is a real one: **humans love seeing who is #1.** There is
a genuine fan base in it, and engagement follows. That is a product asset and
a security risk at the same time, because a public ranking invites
optimisation for rank rather than for quality — the moment the score is the
goal, the score stops measuring the thing we cared about.

So the design question is not "how do we rank" but **"what is the ranking
protecting us from, and can it be gamed by the thing it ranks?"**

- Evaluate on what a hive actually *did*, not what it claimed — hivv already
  learned this the hard way: `local_models` were self-reported with zero
  verification, and the fix was to sign the claim, not to trust it.
- Probe, do not trust. hivv reads `/v1/models` to get the real model id
  instead of believing the advertised name. That instinct generalises.
- Keep the human-facing #1 (they love it) but make the *trust* score a
  separate number that cannot be bought with fan energy.

---

## Many styles, not one

Originally one style — consistency, easier to reason about. **Wiser now:
support many styles of AI.** Personality is vital to most users; a network
that only speaks in one voice is a network people leave.

This is also a security thing, which is why it sits next to ranking: a
single style is a single fingerprint. Variety is camouflage.

The technical shape it points at: **KwaaiNet may evolve into custom neural
nets — hardware style — because it is already sharding every AI across the
same machines.** Once your hardware is serving Llama, Gemma, Qwen and
whatever next, the interesting question stops being "which model" and starts
being "what does this box do best". Sharding is the forcing function: it
makes the hardware the constant and the model the variable.

Not proposing anything yet. Just noting where the pressure points.

---

## Real home networks

What Asher likes most: **real home networks, real home side projects.** Real
fast, real wise. Not datacentre cosplay — machines people actually own, in
houses people actually live in, doing something useful for the person who
lives there.

This constrains everything above in a useful way: a home node has to be
cheap to run, honest about its limits, and never a liability to the household
it sits in. That is a different set of tradeoffs than a cloud deployment, and
it is the set worth optimising for.

---

## LYRZ: active wealth, not stored wealth

The idea is **ACTIVATING and ACTIVE WEALTH** — speed, and helping people who
*use* money. Not hoarding, not a balance that sits still.

Where this differs from people who already have money: wealth you are
protecting and wealth you are putting to work have opposite intuitions about
risk, speed, and who to trust. A project about *moving* money fast to people
who spend it optimises for different things than a project about *keeping*
money safe. Both are legitimate. They just cannot share a steering wheel.

(Stated as a structural observation about incentives, not a judgement about
anyone. Asher's note on Reza stands: he is already comfortable financially,
which is a different relationship to an "active wealth" project. Worth
weighing when LYRZ design decisions are made.)

---

## Priority order

1. **Human comfort first.**
2. Development second.

Dev's own brief: focus on development, fun, and speed. Human-facing choices
are Asher's to make; the job here is to make them cheap to try and fast to
change.

---

## Status tabs

- **PR KwaaiNet#322** — five nested-config readers fixed; gemma-4 loads;
  prefill 3.2x faster; 12/12 CI green.
- **Two-way bridge works** — `kwaainet hive ask hivv` → `pong` (247 ms), and
  hivv routes to our KwaaiNet node on loopback. Both ends proven live.
- **Still `broken` network-wide**: coverage, not loading. One node holds 4 of
  35 gemma blocks; qwen likewise. Separate problem, same for both.
