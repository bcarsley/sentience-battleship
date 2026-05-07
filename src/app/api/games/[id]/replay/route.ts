import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { errorResponse } from "@/lib/auth";
import { ShipType } from "@/lib/game-rules";

// Public, read-only replay of a completed game.
// No ship positions, no tokens, no player IDs — just the move sequence.
// Safe to expose because game.state === 'ended' means nothing is hidden anymore.

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: gameId } = await params;
    const sb = adminClient();

    const { data: game, error: gameErr } = await sb
      .from("games")
      .select(
        "id, mode, ai_difficulty, winner_slot, state, created_at, ended_at"
      )
      .eq("id", gameId)
      .maybeSingle();

    if (gameErr) {
      console.error("[api/replay] DB error:", gameErr);
      return NextResponse.json({ error: "Failed to load replay" }, { status: 500 });
    }
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    if (game.state !== "ended") {
      return NextResponse.json(
        { error: "Replay is only available for completed games" },
        { status: 409 }
      );
    }

    const { data: players } = await sb
      .from("players")
      .select("id, slot, is_ai")
      .eq("game_id", gameId);

    const slotByPlayerId = new Map<string, 1 | 2>(
      (players ?? []).map((p) => [p.id, p.slot as 1 | 2])
    );
    const isAiByPlayerId = new Map<string, boolean>(
      (players ?? []).map((p) => [p.id, p.is_ai])
    );

    const { data: shots } = await sb
      .from("shots")
      .select(
        "shooter_player_id, target_row, target_col, result, ship_id, shot_at"
      )
      .eq("game_id", gameId)
      .order("shot_at", { ascending: true });

    // Look up ship types for sunk shots
    const sunkShipIds = Array.from(
      new Set(
        (shots ?? [])
          .filter((s) => s.result === "sunk" && s.ship_id)
          .map((s) => s.ship_id as string)
      )
    );
    const shipTypeById = new Map<string, ShipType>();
    if (sunkShipIds.length > 0) {
      const { data: ships } = await sb
        .from("ships")
        .select("id, ship_type")
        .in("id", sunkShipIds);
      (ships ?? []).forEach((s) =>
        shipTypeById.set(s.id, s.ship_type as ShipType)
      );
    }

    const moves = (shots ?? []).map((s) => ({
      shooter_slot: slotByPlayerId.get(s.shooter_player_id) ?? null,
      shooter_is_ai: isAiByPlayerId.get(s.shooter_player_id) ?? false,
      row: s.target_row,
      col: s.target_col,
      result: s.result as "hit" | "miss" | "sunk",
      ship_type:
        s.result === "sunk" && s.ship_id
          ? shipTypeById.get(s.ship_id) ?? null
          : null,
      shot_at: s.shot_at,
    }));

    const created = game.created_at ? new Date(game.created_at).getTime() : 0;
    const ended = game.ended_at ? new Date(game.ended_at).getTime() : 0;
    const duration_seconds =
      ended && created ? Math.round((ended - created) / 1000) : null;

    return NextResponse.json({
      game: {
        id: game.id,
        mode: game.mode,
        ai_difficulty: game.ai_difficulty,
        winner_slot: game.winner_slot,
        created_at: game.created_at,
        ended_at: game.ended_at,
        duration_seconds,
      },
      total_moves: moves.length,
      moves,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
