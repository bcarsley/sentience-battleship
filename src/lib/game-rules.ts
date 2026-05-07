export const BOARD_SIZE = 10;

export type ShipType =
  | "carrier"
  | "battleship"
  | "cruiser"
  | "submarine"
  | "destroyer";

export const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};

export const SHIP_TYPES: ShipType[] = [
  "carrier",
  "battleship",
  "cruiser",
  "submarine",
  "destroyer",
];

export type Cell = { row: number; col: number };
export type Orientation = "horizontal" | "vertical";

export type ShipPlacement = {
  ship_type: ShipType;
  row: number;
  col: number;
  orientation: Orientation;
};

export function expandPlacement(p: ShipPlacement): Cell[] {
  const len = SHIP_SIZES[p.ship_type];
  const cells: Cell[] = [];
  for (let i = 0; i < len; i++) {
    cells.push({
      row: p.row + (p.orientation === "vertical" ? i : 0),
      col: p.col + (p.orientation === "horizontal" ? i : 0),
    });
  }
  return cells;
}

export function cellsInBounds(cells: Cell[]): boolean {
  return cells.every(
    (c) =>
      c.row >= 0 && c.row < BOARD_SIZE && c.col >= 0 && c.col < BOARD_SIZE
  );
}

export function cellsOverlap(a: Cell[], b: Cell[]): boolean {
  const set = new Set(a.map((c) => `${c.row},${c.col}`));
  return b.some((c) => set.has(`${c.row},${c.col}`));
}

export type PlacementValidation = { valid: true } | { valid: false; reason: string };

export function validatePlacements(
  placements: ShipPlacement[]
): PlacementValidation {
  const seen = new Set<ShipType>();
  const occupied: Cell[] = [];
  for (const p of placements) {
    if (seen.has(p.ship_type)) {
      return { valid: false, reason: `Duplicate ship: ${p.ship_type}` };
    }
    seen.add(p.ship_type);
    const cells = expandPlacement(p);
    if (!cellsInBounds(cells)) {
      return { valid: false, reason: `${p.ship_type} out of bounds` };
    }
    if (cellsOverlap(occupied, cells)) {
      return { valid: false, reason: `${p.ship_type} overlaps another ship` };
    }
    occupied.push(...cells);
  }
  for (const t of SHIP_TYPES) {
    if (!seen.has(t)) {
      return { valid: false, reason: `Missing ship: ${t}` };
    }
  }
  return { valid: true };
}
