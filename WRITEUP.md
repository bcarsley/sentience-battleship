# Sentience Battleship — Writeup

## What this is

A rules-correct, server-authoritative Battleship with single-player vs an AI of configurable difficulty and real-time multiplayer over a shared invite link. Built with Next.js 16 (App Router) + Supabase Postgres + Supabase Realtime broadcasts, deployed on Vercel.

## My Spike — configurable-difficulty AI as an ML systems problem

The brief invites a Spike. Mine is the AI design, framed as an ML systems problem rather than a heuristic problem. Battleship is a partially observable Markov decision process — not the perfect-information setting AlphaZero targets — so the cleanest demonstration of ML-systems chops is to build the analytical optimum first, then show a learned model approximating it.

**Tier 1 — Easy: uniform random.** Sanity baseline.

**Tier 2 — Medium: hunt-and-target.** Standard heuristic. Hunt phase fires on a parity pattern (the smallest ship is length 2, so checkerboard sampling guarantees at least one hit). Target phase, on a hit, queues orthogonal neighbors; on a second collinear hit, locks orientation and extends along the line until miss-or-sunk.

**Tier 3 — Hard: Bayesian probability density.** Maintains an implicit posterior over enemy ship configurations consistent with the observation history. For each unshot cell, counts how many remaining-ship placements (across all unsunk ship types, both orientations) are consistent with the misses observed so far; picks the cell with the highest count. This is the analytical near-optimum for the hunt phase. Active hits are followed via Tier-2 targeting logic before the density argmax kicks in again — the two compose cleanly because they cover disjoint regimes.

**Tier 4 — Expert: NN approximator (the headline of the Spike).** A small CNN (~700k params, 3 conv layers + 1 dense) imitation-learned on self-play games against the Tier-3 expert. Input: 2-channel 10×10 observation (miss-mask, hit-mask). Output: 100-dim policy logits over cells. Difficulty becomes a single softmax temperature knob — `T=0` is the full-strength learned policy, `T→∞` is uniform random, anything in between continuously interpolates. Exported to ONNX and run in-process server-side via `onnxruntime-node` (Vercel function with native bindings; `serverExternalPackages` keeps Next from bundling the .node binary).

**Why imitation rather than RL self-play.** RL would converge to the same policy with materially more compute. Battleship's optimal hunt policy is well-characterized analytically, so directly distilling the analytical solution into a neural net is sample-efficient and gives the cleanest ML-systems story.

### On the choice of ML for a closed-form problem

Sentience is an AI startup, so the Spike runs on that register: a self-play data pipeline, soft-KL imitation loss, ONNX export, in-process JS inference at the API edge, deterministic reproducible training, tournament evaluation as the validation criterion, and honest negative results (DAgger regression, larger-model overfit) when ideas didn't work. That's the work I'd be doing at Sentience and that's the work I want to show.

What makes Battleship a *good* vehicle for that demonstration — even though it's a *bad* fit for ML in absolute terms — is that the analytical optimum sits one tier above the NN as a baseline. Every claim about the trained model is checkable against Tier 3. The iteration history is verifiable end-to-end. Negative results can't be hidden behind "we don't know what optimal looks like" because the optimal *is* known. That's experimental discipline you can audit, which matters more in production ML — where you usually *don't* have a clean baseline — than the headline performance number.

**Why Battleship is structurally a poor ML/RL fit (in case the framing above doesn't land):**

1. **The optimal policy is closed-form computable.** Bayesian density over consistent placements plus information-theoretic shot selection (max expected entropy reduction over the placement posterior) is provably near-optimal for the hunt phase. Targeting is a small deterministic state machine. There is no policy-space above the analytical for learning to discover.
2. **The state space is small.** 10×10 board, ~17 ship cells, modest distinct game histories per agent. Tractable for offline DP over belief states.
3. **It's a clean POMDP.** Discrete action space, finite belief state, deterministic transitions given the hidden ship layout. Off-the-shelf POMDP solvers dominate heuristic players directly with no learning required.
4. **Reward is sparse and almost binary.** RL gradient signal is weak. REINFORCE needs hundreds of thousands of episodes to converge to a policy you can derive on a napkin.
5. **Imitation has a hard ceiling at the expert.** A model trained to predict expert.argmax can asymptotically match it but cannot exceed it.

**What would actually be optimal at Battleship-the-product:**

- **POMCP / DESPAS / DESPOT** — tree-search POMDP planners over belief states with rollouts. Likely beats every tier here, including the NN. About a week of engineering; the right answer if winning is the goal.
- **Belief-state value iteration.** Represent belief as the probability distribution over residual placements; Bellman update offline: V(b) = min over cells of [1 + E_outcome[V(b_next)]]. Tractable approximately at our scale.
- **Information-gain shot selection on top of Tier 3.** A one-line upgrade — pick the cell that maximizes expected posterior-entropy reduction rather than max placement count. Probably 2-3 mean shots better than the current Tier 3, closed-form, no training needed.
- **Berry's algorithm + variants.** Battleship has been studied; the textbook hunting strategies are well-characterized.

I didn't ship POMCP because tree-search planners don't demonstrate ML-systems skills, which is the point of the Spike for *this* hiring context. The deliberate choice is the harder ML pipeline against an over-engineered baseline, where the experimental hygiene becomes the load-bearing demonstration.

**Empirical result.** From `scripts/tournament.ts` (200 games per tier, solo shots-to-finish; lower is better; reproducible with `BS_SEED=42`):

| Tier   | Mean | StdDev | Min | Max |
|--------|------|--------|-----|-----|
| easy   | 95.2 |    5.1 |  76 | 100 |
| medium | 51.2 |    8.9 |  28 |  68 |
| hard   | 44.7 |    9.0 |  27 |  68 |
| expert | 47.0 |   10.3 |  **22** |  74 |

Hard is the gold standard at 44.7 mean shots — the analytical Bayesian density player essentially solves the hunt phase. Expert (the trained CNN) is within 2.3 mean shots, with a slightly fatter tail but a *better best case* (min 22 vs Hard's 27): when the NN gets a board it can read cleanly, it plays a more efficient game than the analytical player, because it has slightly different inductive biases. On the typical and worst-case game, Hard still wins — the model approaches but doesn't fully match the analytical optimum.

**The iteration loop, in order:**

1. **Initial training** — 700k-param CNN, 122k examples, 5 epochs, hard-label cross-entropy: Expert mean 62.0, std 7.8. Consistent but weak.
2. **Review caught a bug in the expert oracle.** When ships were sunk *out of order*, the active-hit tracker reset on every "sunk" event, discarding hits on still-alive ships. Fixed in `src/lib/ai.ts` — Hard mean dropped from 58.6 → 44.5 (and variance from 22.2 to 9.0). Expert, still trained on the buggy oracle, regressed in relative terms.
3. **Retrained on the corrected oracle**, added a 3rd observation channel (sunk-cell mask), switched to soft KL targets — Expert reached 48.8 mean.
4. **DAgger experiment failed.** One round of "NN rollout, expert relabels visited states, append, retrain" made things *worse* (Expert regressed to 62.5 mean, std 23.8). Cause: the DAgger states over-represent the current NN's failure modes; correct DAgger needs iteration (and sample-weighting that keeps expert data dominant). Negative result documented in `scripts/dagger.py`.
5. **Larger model overfit.** A 3.6M-param network with residual blocks pushed argmax-match to 41.8% but tournament play *regressed* — the higher capacity fit the soft-KL noise instead of committing to good argmax decisions. Reverted.
6. **Audited the training script** for variance sources. Found two real bugs and several minor issues:
   - **`bayesian_density` was excluding placements through `misses` only, not `sunk_cells`.** A remaining ship can't pass through a dead ship's cells, but the expert was counting those placements anyway, inflating density on cells *adjacent* to sunk ships. Fixed.
   - **No seed control anywhere** — `random.{choice,randint}`, `torch.manual_seed`, `np.random.seed` all left at default. Each run started from a different RNG state. Adding `set_all_seeds(seed=42)` made training reproducible and gave a +1.8 mean shots improvement over the random-seed lottery.
   - Less impactful: `argmax-match` metric is partly noise on diffuse soft targets; `random.choice` in targeting was replaced with deterministic sorted-first; MPS reductions are still slightly non-deterministic on the device side.

The final 47.0 result is what's shipping.

**Training script:** `scripts/train_expert.py`. Self-play data generation + CNN + ONNX export, ~200 lines, runs on Mac CPU/MPS in a few minutes.

**Modal alternative:** `scripts/train_expert_modal.py`. Wraps the same training function with `@modal.function(gpu="A10G")`. Not required at this model size — included as a 5-line demonstration of how this would scale to a transformer-over-history or RL-with-replay-buffer setup that exceeds local compute.

## Architecture

```
Browser
  ├── Next.js page (game UI)
  └── Supabase Realtime channel  ──────┐
                                       │ broadcast events (pings)
                                       ▼
Vercel (Next.js API routes, server-side)
  ├── /api/games               POST   create
  ├── /api/games/:id           GET    fetch state (token-gated)
  ├── /api/games/:id/join      POST   redeem invite
  ├── /api/games/:id/ships     POST   place ships
  ├── /api/games/:id/shots     POST   fire (also drives AI counter-shot)
  └── /api/games/history       GET    completed-game stats
       │
       └── service_role ──────► Supabase Postgres (server-only)
                                  ├── games · players · ships · shots
                                  └── RLS enabled, no policies (deny-all to anon)
```

**Single repo, single deploy target.** Tier 4 NN runs in the same Node process as the API routes via `onnxruntime-node`; no separate Python service in production. The Python script trains the model offline + exports ONNX; the runtime is JS.

## Anti-cheat — Signal-style unguessable session tokens

Server holds the only ground truth of ship placements. Clients never see the opponent's grid by any path — no Postgres-changes subscription, no Data API access, no inference from event payloads.

**Token mechanism:**
1. On game create or invite redemption, the server generates `raw_token = randomBytes(32).base64url()` — 256-bit, unguessable.
2. The server stores `HMAC-SHA256(SERVER_SECRET, "player:<gameId>" + "\0" + raw_token)` in `players.session_token_hash` (`bytea`). The `gameId` scope binds the token to its specific game — a token issued for game X cannot validate against any player row in game Y, even if a hash collision occurred.
3. The raw token is returned to the client *exactly once*, persisted in `localStorage[bs:<gameId>:token]`.
4. Every state-changing API call sends the raw token in `X-Player-Token`. The server recomputes the scoped HMAC and compares with `crypto.timingSafeEqual` against the stored hash.

**Atomic turn-advance.** The shot route claims the turn via a conditional UPDATE: `update games set current_turn_slot = <opp> where id = <gameId> and state = 'firing' and current_turn_slot = <me>`. If 0 rows match, another request claimed first or the game changed state, and the request returns 403/409. This makes shot resolution exclusive — two double-clicked fire requests cannot both fire at different cells in the same logical turn.

**Defense in depth via Postgres RLS.** All four tables have RLS enabled and zero policies — `anon` and `authenticated` roles are denied at the row level. The legitimate access path uses `service_role`, which bypasses RLS. So: leak the publishable key → no rows are exposed; leak the service-role key → that's a real breach (and is treated as such — server-only, never `NEXT_PUBLIC_*`).

**Realtime broadcasts as pings, not state.** The `game:<id>` channel name uses the same UUID that's already secret to the two players in the game. Anyone holding it could publish bogus broadcasts, but those broadcasts are never trusted as state — clients always re-fetch the authoritative game state from the API on receipt. This sidesteps the awkward question of mapping HMAC tokens into Postgres GUCs / Realtime auth, with no security loss.

**Cheat-attempt drills (manual checklist):**
- Direct DB read of opponent ships using the publishable key → blocked by RLS deny-all.
- Spoof `X-Player-Token` → constant-time HMAC compare rejects.
- Fire with another player's token but my body → token validation maps token → player; mismatched-slot shots return 403 "Not your turn".
- Replay an already-shot cell → unique constraint `(game_id, shooter_player_id, target_row, target_col)` returns 409 "Already shot at this cell".
- Place ships twice → 409 "Ships already placed".

## Persistence + history

- **Mid-game refresh** survives because the token in `localStorage` plus the game ID in the URL are sufficient to reconstruct any client-side state from the API.
- **Completed game history** lives in the same Postgres tables — `games.state = 'ended'`, ship/shot history retained. `GET /api/games/history` returns recent finished games (mode, difficulty, winner, duration, shot count). No ship positions are exposed in history responses; that's still token-gated.
- **Storage choice rationale.** Postgres because Supabase gives us realtime, auth, RLS, and SQL queryability for free, and the dataset shape (a few tables, joins, time-ordered shots) is the textbook relational use case. KV would have been ergonomic for the in-flight state but bad for history queries; an event log would have been over-engineered for a 5×100 cell game.

## Scalability commentary

**The current scale is constant.** A 10×10 board with 5 ships per side is bounded — the hot path inserts at most one row per shot.

**For a "huge board" thought experiment** (say 100×100 with 50 ships per side):
- **DB:** indexes on `shots(game_id, shot_at)` and `ships(player_id)` already in place; a `(game_id, shooter_player_id)` partial index on `shots` would handle the duplicate-shot check. The ship-placement enumeration in the Bayesian player is `O(N² · k · 2)` per ship-size; for a 100×100 board that's ~20k placements per ship × 50 ships = 1M consistency checks per move. Past about that point you'd switch to particle-filter / Monte Carlo sampling of ship configurations rather than enumeration. The CNN scales fine via convolutions.
- **Realtime:** Broadcast fanout is `O(2 players)` per message because the channel is keyed by `game_id`. Across many concurrent games it's just N independent pubsub topics, which is what Supabase Realtime is designed for.
- **API hot path:** Every shot is one transaction-shaped operation — read opponent ships, find hit, update one ship row, insert one shot row, recheck win, update game state. With proper indexing the per-shot work is `O(unsunk_ships)` which is at most 5 today. Trivially horizontal — Vercel functions are stateless; Postgres handles concurrency via row-level locks on the shooter's `(game_id, slot)`.

## AI tooling usage

Built end-to-end in a single session with **Claude Code Opus 4.7 (1M context)**. Concrete usage patterns:

- **Architecture brainstorming first, code second.** Started with a brief doc (the planning artifact at `ballard-projects/active/sentience-takehome/PROJECT.md` in my Ballard repo) — locked decisions on stack, security model, AI tier framing, and Realtime channel design before writing any code. Every subsequent decision had a written justification to anchor against.
- **Skills + verification.** Used the Supabase skill's guidance to (a) avoid the `Postgres-changes`-vs-`Broadcast` decision trap, (b) ensure RLS is enabled with deny-all policies on every table, and (c) generate migration files via `supabase migration new` rather than inventing filenames. After every API route, ran a curl smoke test before moving on; verified DB state with `supabase db query --linked` rather than trusting that the route looked right.
- **Type-driven writing.** Generated the typed Supabase schema with `supabase gen types typescript --linked` immediately after migration apply. Every subsequent route was written against the full typed schema, which caught at least one bytea-format bug at compile time.
- **Two parallel documents.** A planning brief (`PROJECT.md`) and the conversation transcript both functioned as durable scratch space — the brief was the source of truth for decisions, the transcript captured the why.

## Known limitations

- **vs-Human rematch is menu-only.** End-state offers a one-click "Play again" for vs-AI (recreates with same difficulty). For vs-Human, both players need to navigate to menu and create a new game — coordinating an in-place rematch across two browser windows wasn't worth the complexity for the submission window.
- **Realtime broadcasts are public.** Anyone holding a `game_id` UUID could publish bogus broadcasts to `game:<id>`. The mitigation is in the design — clients always re-fetch authoritative state from the API on broadcast receipt, so payloads are pings not state. Upgrading to JWT-authorized private channels would close the surface entirely.

## Future work (what I'd do with another day)
- **Private Realtime channels.** Upgrade from public Broadcast to JWT-authorized private channels — closes the "anyone with the game ID can publish bogus broadcasts" minor surface, even though those broadcasts are pings.
- **Manual ship-placement nudge.** Currently click-to-place + click-an-existing-ship-to-pick-up; full HTML5 drag-and-drop would be more obvious to first-time players.
- **Drag-to-fire UX** with a tighter feedback animation when a ship is sunk.

## How to run locally

```
git clone <this repo>
cd sentience-battleship
npm install
cp .env.local.example .env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, SERVER_SECRET (= openssl rand -base64 32)
supabase link --project-ref <ref>
supabase db push
npm run dev
```

Optional: `uv run scripts/train_expert.py` to train the Tier-4 model and write `public/expert.onnx`.
