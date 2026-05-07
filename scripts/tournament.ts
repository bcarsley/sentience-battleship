/**
 * Tier-vs-tier evaluation: how many shots does each AI tier take to sink
 * all 5 randomly placed enemy ships? Lower = better.
 *
 * Run: npx tsx scripts/tournament.ts [num_games_per_tier]
 *
 * The "solo" framing isolates AI quality from opponent placement skill —
 * we're measuring hunt+target efficiency on independently-random boards.
 */

import {
  BOARD_SIZE,
  expandPlacement,
  ShipType,
} from "../src/lib/game-rules";
import { randomShipPlacement } from "../src/lib/random-placement";
import { AIDifficulty, AIShotRecord } from "../src/lib/ai";
import { pickAIShotAsync } from "../src/lib/expert";

type ShipState = {
  ship_type: ShipType;
  length: number;
  cells: Set<string>;
  hits: Set<string>;
  sunk: boolean;
};

async function playSolo(difficulty: AIDifficulty): Promise<number> {
  const placements = randomShipPlacement();
  const ships: ShipState[] = placements.map((p) => ({
    ship_type: p.ship_type,
    length: expandPlacement(p).length,
    cells: new Set(expandPlacement(p).map((c) => `${c.row},${c.col}`)),
    hits: new Set(),
    sunk: false,
  }));

  const history: AIShotRecord[] = [];
  let shots = 0;
  const cap = BOARD_SIZE * BOARD_SIZE;

  while (ships.some((s) => !s.sunk) && shots < cap) {
    const remaining = ships.filter((s) => !s.sunk).map((s) => s.ship_type);
    const cell = await pickAIShotAsync(difficulty, history, remaining);
    const key = `${cell.row},${cell.col}`;

    let result: "hit" | "miss" | "sunk" = "miss";
    let shipType: ShipType | undefined = undefined;
    for (const ship of ships) {
      if (ship.sunk) continue;
      if (ship.cells.has(key)) {
        ship.hits.add(key);
        shipType = ship.ship_type;
        if (ship.hits.size >= ship.length) {
          ship.sunk = true;
          result = "sunk";
        } else {
          result = "hit";
        }
        break;
      }
    }

    history.push({ row: cell.row, col: cell.col, result, ship_type: shipType });
    shots++;
  }
  return shots;
}

type Stats = { mean: number; std: number; min: number; max: number; n: number };

function summarize(samples: number[]): Stats {
  const n = samples.length;
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance =
    samples.map((x) => (x - mean) ** 2).reduce((a, b) => a + b, 0) / n;
  return {
    mean,
    std: Math.sqrt(variance),
    min: Math.min(...samples),
    max: Math.max(...samples),
    n,
  };
}

async function runTier(d: AIDifficulty, n: number): Promise<Stats> {
  const samples: number[] = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    samples.push(await playSolo(d));
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`  ${d}: ${n} games in ${elapsed}s\n`);
  return summarize(samples);
}

async function main() {
  const N = parseInt(process.argv[2] ?? "100", 10);
  process.stderr.write(`Running ${N} solo games per tier…\n`);

  const tiers: AIDifficulty[] = ["easy", "medium", "hard", "expert"];
  const results: Array<{ tier: AIDifficulty; stats: Stats }> = [];
  for (const t of tiers) {
    results.push({ tier: t, stats: await runTier(t, N) });
  }

  console.log();
  console.log(`Solo shots-to-finish (${N} games per tier, lower is better):`);
  console.log();
  console.log("| Tier   | Mean | StdDev | Min | Max |");
  console.log("|--------|------|--------|-----|-----|");
  for (const { tier, stats } of results) {
    console.log(
      `| ${tier.padEnd(6)} | ${stats.mean.toFixed(1).padStart(4)} | ${stats.std
        .toFixed(1)
        .padStart(6)} | ${String(stats.min).padStart(3)} | ${String(
        stats.max
      ).padStart(3)} |`
    );
  }
  console.log();

  const baseline = results.find((r) => r.tier === "easy")?.stats.mean ?? 0;
  console.log("Speedup vs Easy (random) baseline:");
  for (const { tier, stats } of results) {
    if (tier === "easy") continue;
    const speedup = ((baseline - stats.mean) / baseline) * 100;
    console.log(`  ${tier.padEnd(6)}: ${speedup.toFixed(1)}% fewer shots`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
