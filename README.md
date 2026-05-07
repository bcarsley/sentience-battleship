# Battleship — Sentience take-home submission

Server-authoritative Battleship with vs-AI single-player (four difficulty tiers, including a trained CNN) and vs-Human realtime multiplayer over a shareable invite link. Built for the Sentience engineering work trial.

**Reviewers, start here:**

- 📄 [`WRITEUP.md`](./WRITEUP.md) — the actual submission deliverable. Architecture, anti-cheat model, AI tier walkthrough (the Spike), iteration history with empirical numbers, ML-fit critique, AI-tooling-usage notes.
- 🎮 **Live demo:** *(URL added after Vercel deploy)*
- 🐙 **Repo:** [github.com/bcarsley/sentience-battleship](https://github.com/bcarsley/sentience-battleship)

---

## What this is

A complete, rules-correct Battleship implementation with the brief's two modes (vs-AI single-player, vs-Human two-window realtime multiplayer), persistence across page refresh, and a queryable history of completed games. The Spike — the differentiated piece — is the AI design: four difficulty tiers, with Tier 4 being a CNN trained via imitation learning of an analytical Bayesian-density player, exported to ONNX, and run in-process on the API edge via `onnxruntime-node`.

## Try it locally

Prereqs: Node 24, npm, a Supabase project (free tier works), `uv` if you want to retrain the model.

```bash
git clone https://github.com/bcarsley/sentience-battleship
cd sentience-battleship
npm install
cp .env.local.example .env.local
# Fill in:
#   NEXT_PUBLIC_SUPABASE_URL
#   NEXT_PUBLIC_SUPABASE_ANON_KEY      (publishable key)
#   SUPABASE_SERVICE_ROLE_KEY          (secret key)
#   SERVER_SECRET=$(openssl rand -base64 32)

# Apply schema:
supabase link --project-ref <your-ref>
supabase db push

npm run dev    # http://localhost:3000
```

To retrain the Tier-4 model (deterministic, seed=42, ~1 min on M-series Mac):

```bash
uv run scripts/train_expert.py
```

To benchmark all four AI tiers against random ship placements:

```bash
npx tsx scripts/tournament.ts 200
```

## Project layout

```
src/
├── app/
│   ├── api/games/        # POST create, GET state, POST shots, POST ships, POST join, GET history, GET replay
│   ├── g/[id]/           # game page (placement → firing → ended)
│   ├── history/          # public game-history browser + per-game replay viewer
│   └── page.tsx          # landing
├── lib/
│   ├── supabase.ts       # admin (service-role) + browser (publishable) clients
│   ├── tokens.ts         # HMAC token gen, scoped per-game; bytea wire-format
│   ├── auth.ts           # authorizePlayer(), error response shaping
│   ├── ai.ts             # Tier 1-3: random / hunt-and-target / Bayesian density
│   ├── expert.ts         # Tier 4: ONNX inference wrapper + dispatcher
│   ├── game-rules.ts     # board/ship constants + placement validation
│   ├── random-placement.ts
│   └── realtime.ts       # server-side broadcast publisher
├── lib/database.types.ts # generated from `supabase gen types typescript --linked`
└── ...

scripts/
├── train_expert.py       # imitation-learning trainer (Bayesian expert → CNN, ONNX export)
├── train_expert_modal.py # Modal-flavored alternative (not run; included as reference)
├── train_best_of_n.py    # multi-seed candidate selection
├── dagger.py             # negative result documented in WRITEUP.md
└── tournament.ts         # head-to-head AI tier evaluation

supabase/migrations/
└── 20260507155334_initial_schema.sql

public/
└── expert.onnx           # 2.7 MB, trained CNN policy network

WRITEUP.md                # ★ the actual submission deliverable
```

## Stack

- **Frontend + API:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4
- **DB / Realtime / Auth:** Supabase Postgres with RLS deny-all to anon (server-only access via service-role)
- **AI inference:** `onnxruntime-node` (native bindings, kept out of the bundle via `serverExternalPackages`)
- **AI training:** PyTorch on Apple Silicon (MPS), ONNX export, deterministic seed=42
- **Hosting:** Vercel
- **Test:** Vitest unit + manual cheat-drill curls (logged in `WRITEUP.md`)

## Anti-cheat model — short version

Server holds the only ground-truth ship positions. Clients never see opponent ships by any path. Each player gets a 256-bit unguessable session token, HMAC'd with `SERVER_SECRET` scoped to the game ID, stored as a `bytea` hash. Every state-changing API call goes through `authorizePlayer` with a constant-time HMAC compare. Postgres RLS is deny-all to anon as defense-in-depth — leaking the publishable key exposes nothing. The shot route uses an atomic conditional `UPDATE` to claim the turn, preventing same-player double-fire even under double-clicked button races.

Full threat model + manual cheat-drill checklist in [`WRITEUP.md`](./WRITEUP.md).

## The Spike

Configurable-difficulty AI as an ML-systems demonstration:

- **Tier 1 — Easy:** uniform random
- **Tier 2 — Medium:** parity-pattern hunt + orthogonal-neighbor target
- **Tier 3 — Hard:** Bayesian probability density over consistent ship placements (analytical near-optimum)
- **Tier 4 — Expert:** small CNN imitation-learned on Tier 3, ONNX export, in-process inference

Tournament results (200 games per tier, solo shots-to-finish):

| Tier   | Mean | StdDev | Min | Max |
|--------|------|--------|-----|-----|
| easy   | 95.2 |    5.1 |  76 | 100 |
| medium | 51.2 |    8.9 |  28 |  68 |
| hard   | 44.7 |    9.0 |  27 |  68 |
| expert | 47.0 |   10.3 |  22 |  74 |

The full iteration history (oracle bug, DAgger negative result, larger-model overfit, training-script audit, ML/RL-fit critique) lives in [`WRITEUP.md`](./WRITEUP.md).

## On AI tooling usage

Built end-to-end with **Claude Code (Opus 4.7, 1M context)**. The brief explicitly evaluates AI-collaboration as a deliverable; the writeup covers concrete usage patterns (planning brief first, security audit subagent, Playwright UX subagent, type-driven writing against generated Supabase types, etc.).

## License

This is a private submission for Sentience. No license granted.
