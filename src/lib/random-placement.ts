import {
  BOARD_SIZE,
  Cell,
  Orientation,
  SHIP_TYPES,
  ShipPlacement,
  cellsInBounds,
  cellsOverlap,
  expandPlacement,
} from "./game-rules";

function occupied(placements: ShipPlacement[]): Cell[] {
  return placements.flatMap((p) => expandPlacement(p));
}

export function randomShipPlacement(): ShipPlacement[] {
  for (let restart = 0; restart < 50; restart++) {
    const result: ShipPlacement[] = [];
    let failed = false;
    for (const shipType of SHIP_TYPES) {
      let placed = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        const orientation: Orientation =
          Math.random() < 0.5 ? "horizontal" : "vertical";
        const row = Math.floor(Math.random() * BOARD_SIZE);
        const col = Math.floor(Math.random() * BOARD_SIZE);
        const candidate: ShipPlacement = {
          ship_type: shipType,
          row,
          col,
          orientation,
        };
        const cells = expandPlacement(candidate);
        if (!cellsInBounds(cells)) continue;
        if (cellsOverlap(occupied(result), cells)) continue;
        result.push(candidate);
        placed = true;
        break;
      }
      if (!placed) {
        failed = true;
        break;
      }
    }
    if (!failed) return result;
  }
  throw new Error("randomShipPlacement: exhausted retries");
}
