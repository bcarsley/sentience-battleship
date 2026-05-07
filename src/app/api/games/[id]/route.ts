import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import {
  authorizePlayer,
  errorResponse,
  readPlayerToken,
} from "@/lib/auth";
import { ShipType } from "@/lib/game-rules";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: gameId } = await params;
    const token = readPlayerToken(req);
    const me = await authorizePlayer(gameId, token);

    const sb = adminClient();

    const { data: game, error: gameErr } = await sb
      .from("games")
      .select(
        "id, mode, state, current_turn_slot, winner_slot, ai_difficulty, created_at, ended_at"
      )
      .eq("id", gameId)
      .single();

    if (gameErr || !game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    const { data: players } = await sb
      .from("players")
      .select("id, slot, is_ai, ships_placed")
      .eq("game_id", gameId);

    const opponent = (players ?? []).find((p) => p.slot !== me.slot);

    // My ships (with hits — I see my own ships fully)
    const { data: myShips } = await sb
      .from("ships")
      .select("ship_type, length, cells, hit_cells, sunk")
      .eq("player_id", me.id);

    // Opponent's sunk ships (only ship_type names — never positions)
    let opponentSunkTypes: ShipType[] = [];
    if (opponent) {
      const { data: oppShips } = await sb
        .from("ships")
        .select("ship_type, sunk")
        .eq("player_id", opponent.id);
      opponentSunkTypes = (oppShips ?? [])
        .filter((s) => s.sunk)
        .map((s) => s.ship_type as ShipType);
    }

    // All shots in the game
    const { data: allShots } = await sb
      .from("shots")
      .select("shooter_player_id, target_row, target_col, result, ship_id, shot_at")
      .eq("game_id", gameId)
      .order("shot_at", { ascending: true });

    // Build ship_id -> ship_type lookup for any ship referenced in shots
    const shipIds = Array.from(
      new Set((allShots ?? []).map((s) => s.ship_id).filter((x): x is string => !!x))
    );
    const shipTypeById = new Map<string, ShipType>();
    if (shipIds.length > 0) {
      const { data: refShips } = await sb
        .from("ships")
        .select("id, ship_type")
        .in("id", shipIds);
      (refShips ?? []).forEach((s) =>
        shipTypeById.set(s.id, s.ship_type as ShipType)
      );
    }

    const myShots = (allShots ?? [])
      .filter((s) => s.shooter_player_id === me.id)
      .map((s) => ({
        row: s.target_row,
        col: s.target_col,
        result: s.result as "hit" | "miss" | "sunk",
        // Only reveal ship_type on sunk — never on plain hits.
        ship_type:
          s.result === "sunk" && s.ship_id
            ? shipTypeById.get(s.ship_id) ?? null
            : null,
      }));

    const theirShots = (allShots ?? [])
      .filter((s) => s.shooter_player_id !== me.id)
      .map((s) => ({
        row: s.target_row,
        col: s.target_col,
        result: s.result as "hit" | "miss" | "sunk",
      }));

    return NextResponse.json({
      game: {
        id: game.id,
        mode: game.mode,
        state: game.state,
        current_turn_slot: game.current_turn_slot,
        winner_slot: game.winner_slot,
        ai_difficulty: game.ai_difficulty,
      },
      me: {
        slot: me.slot,
        ships_placed: me.ships_placed,
        ships: myShips ?? [],
      },
      opponent: opponent
        ? {
            slot: opponent.slot,
            is_ai: opponent.is_ai,
            ships_placed: opponent.ships_placed,
            sunk_ship_types: opponentSunkTypes,
          }
        : null,
      shots: {
        mine: myShots,
        theirs: theirShots,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
