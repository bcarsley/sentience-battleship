import { BOARD_SIZE, Cell, SHIP_SIZES, SHIP_TYPES, ShipType } from "./game-rules";

export type AIDifficulty = "easy" | "medium" | "hard" | "expert";

export type AIShotRecord = {
  row: number;
  col: number;
  result: "hit" | "miss" | "sunk";
  ship_type?: ShipType | null;
};

function inBounds(c: Cell): boolean {
  return c.row >= 0 && c.row < BOARD_SIZE && c.col >= 0 && c.col < BOARD_SIZE;
}

function key(c: Cell): string {
  return `${c.row},${c.col}`;
}

function pickRandomCell(taken: Set<string>): Cell {
  const free: Cell[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (!taken.has(`${r},${c}`)) free.push({ row: r, col: c });
    }
  }
  if (free.length === 0) throw new Error("No cells left");
  return free[Math.floor(Math.random() * free.length)];
}

function activeHitsByShip(shots: AIShotRecord[]): Map<ShipType, Cell[]> {
  // Group hits by ship_type, drop entries when ship is sunk. Solves the
  // out-of-order-sinking corruption where the old "reset on sunk" approximation
  // would discard hits on a different still-alive ship.
  const byShip = new Map<ShipType, Cell[]>();
  for (const s of shots) {
    if (s.result === "miss") continue;
    if (!s.ship_type) continue;
    if (s.result === "sunk") {
      byShip.delete(s.ship_type);
    } else {
      const arr = byShip.get(s.ship_type) ?? [];
      arr.push({ row: s.row, col: s.col });
      byShip.set(s.ship_type, arr);
    }
  }
  return byShip;
}

function pickHuntTarget(shots: AIShotRecord[]): Cell {
  const taken = new Set(shots.map((s) => key(s)));

  // Pursue the most-recently-hit unsunk ship.
  const byShip = activeHitsByShip(shots);
  let active: Cell[] = [];
  for (let i = shots.length - 1; i >= 0 && active.length === 0; i--) {
    const s = shots[i];
    if (s.result === "hit" && s.ship_type && byShip.has(s.ship_type)) {
      active = byShip.get(s.ship_type) ?? [];
    }
  }

  if (active.length === 1) {
    const h = active[0];
    const candidates: Cell[] = [
      { row: h.row - 1, col: h.col },
      { row: h.row + 1, col: h.col },
      { row: h.row, col: h.col - 1 },
      { row: h.row, col: h.col + 1 },
    ].filter((c) => inBounds(c) && !taken.has(key(c)));
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
  } else if (active.length >= 2) {
    const sorted = active.slice().sort((a, b) => a.row - b.row || a.col - b.col);
    const horiz = sorted.every((h) => h.row === sorted[0].row);
    const vert = sorted.every((h) => h.col === sorted[0].col);
    if (horiz) {
      const row = sorted[0].row;
      const minCol = sorted[0].col;
      const maxCol = sorted[sorted.length - 1].col;
      const candidates = [
        { row, col: minCol - 1 },
        { row, col: maxCol + 1 },
      ].filter((c) => inBounds(c) && !taken.has(key(c)));
      if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    } else if (vert) {
      const col = sorted[0].col;
      const minRow = sorted[0].row;
      const maxRow = sorted[sorted.length - 1].row;
      const candidates = [
        { row: minRow - 1, col },
        { row: maxRow + 1, col },
      ].filter((c) => inBounds(c) && !taken.has(key(c)));
      if (candidates.length > 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
      }
    }
  }

  // Hunt mode: parity pattern (smallest ship is 2, so checker hits every ship)
  const huntable: Cell[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((r + c) % 2 === 0 && !taken.has(`${r},${c}`)) {
        huntable.push({ row: r, col: c });
      }
    }
  }
  if (huntable.length > 0) {
    return huntable[Math.floor(Math.random() * huntable.length)];
  }
  return pickRandomCell(taken);
}

// Bayesian probability density: count placements consistent with observations,
// pick cell with highest count. Near-optimum for hunt phase; combined with
// hunt-and-target's pursuit logic for active-hit phase.
function pickBayesian(
  shots: AIShotRecord[],
  remainingShipTypes: ShipType[]
): Cell {
  const taken = new Set(shots.map((s) => key(s)));
  const misses = new Set(shots.filter((s) => s.result === "miss").map(key));

  // If any ship is hit-but-not-sunk, prefer hunt-target's directional logic.
  const byShip = activeHitsByShip(shots);
  if (byShip.size > 0) {
    return pickHuntTarget(shots);
  }

  // Otherwise: count valid placements per cell across remaining ships.
  const counts = new Float64Array(BOARD_SIZE * BOARD_SIZE);
  for (const shipType of remainingShipTypes) {
    const len = SHIP_SIZES[shipType];
    // Horizontal placements
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c <= BOARD_SIZE - len; c++) {
        let valid = true;
        for (let i = 0; i < len; i++) {
          const k = `${r},${c + i}`;
          if (misses.has(k) || taken.has(k)) {
            valid = false;
            break;
          }
        }
        if (valid) {
          for (let i = 0; i < len; i++) {
            counts[r * BOARD_SIZE + (c + i)] += 1;
          }
        }
      }
    }
    // Vertical placements
    for (let r = 0; r <= BOARD_SIZE - len; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        let valid = true;
        for (let i = 0; i < len; i++) {
          const k = `${r + i},${c}`;
          if (misses.has(k) || taken.has(k)) {
            valid = false;
            break;
          }
        }
        if (valid) {
          for (let i = 0; i < len; i++) {
            counts[(r + i) * BOARD_SIZE + c] += 1;
          }
        }
      }
    }
  }

  // Pick max count cell among unshot cells
  let best: Cell | null = null;
  let bestCount = -1;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (taken.has(`${r},${c}`)) continue;
      const v = counts[r * BOARD_SIZE + c];
      if (v > bestCount) {
        bestCount = v;
        best = { row: r, col: c };
      }
    }
  }
  return best ?? pickRandomCell(taken);
}

export function pickAIShot(
  difficulty: AIDifficulty,
  shots: AIShotRecord[],
  remainingOpponentShips: ShipType[]
): Cell {
  const taken = new Set(shots.map((s) => key(s)));
  switch (difficulty) {
    case "easy":
      return pickRandomCell(taken);
    case "medium":
      return pickHuntTarget(shots);
    case "hard":
    case "expert":
      return pickBayesian(
        shots,
        remainingOpponentShips.length > 0 ? remainingOpponentShips : SHIP_TYPES
      );
  }
}
