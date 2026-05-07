import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import {
  authorizePlayer,
  errorResponse,
  readPlayerToken,
} from "@/lib/auth";
import {
  ShipPlacement,
  SHIP_SIZES,
  expandPlacement,
  validatePlacements,
} from "@/lib/game-rules";
import { randomShipPlacement } from "@/lib/random-placement";
import { broadcastGameUpdate } from "@/lib/realtime";

type ShipInsert = {
  player_id: string;
  ship_type: string;
  length: number;
  cells: Array<{ row: number; col: number }>;
};

function placementsToShipInserts(
  playerId: string,
  placements: ShipPlacement[]
): ShipInsert[] {
  return placements.map((p) => ({
    player_id: playerId,
    ship_type: p.ship_type,
    length: SHIP_SIZES[p.ship_type],
    cells: expandPlacement(p),
  }));
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: gameId } = await params;
    const token = readPlayerToken(req);
    const me = await authorizePlayer(gameId, token);

    const body = await req.json().catch(() => null);
    const placements: ShipPlacement[] | undefined = body?.placements;
    if (!Array.isArray(placements)) {
      return NextResponse.json(
        { error: "placements array required" },
        { status: 400 }
      );
    }

    const validation = validatePlacements(placements);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.reason }, { status: 400 });
    }

    const sb = adminClient();

    const { data: game, error: gameErr } = await sb
      .from("games")
      .select("id, mode, state")
      .eq("id", gameId)
      .single();

    if (gameErr || !game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    if (game.state !== "placing") {
      return NextResponse.json(
        { error: "Placement phase is over" },
        { status: 409 }
      );
    }
    if (me.ships_placed) {
      return NextResponse.json(
        { error: "Ships already placed" },
        { status: 409 }
      );
    }

    // Insert human's ships
    const { error: insertErr } = await sb
      .from("ships")
      .insert(placementsToShipInserts(me.id, placements));
    if (insertErr) {
      console.error("[api/games/ships] insert failed:", insertErr);
      return NextResponse.json(
        { error: "Failed to place ships" },
        { status: 500 }
      );
    }

    await sb
      .from("players")
      .update({ ships_placed: true })
      .eq("id", me.id);

    // For vs-AI, auto-place AI ships at the same time
    if (game.mode === "ai") {
      const { data: aiPlayer } = await sb
        .from("players")
        .select("id, ships_placed")
        .eq("game_id", gameId)
        .eq("is_ai", true)
        .single();

      if (aiPlayer && !aiPlayer.ships_placed) {
        const aiPlacements = randomShipPlacement();
        const { error: aiInsertErr } = await sb
          .from("ships")
          .insert(placementsToShipInserts(aiPlayer.id, aiPlacements));
        if (aiInsertErr) {
          console.error("[api/games/ships] AI insert failed:", aiInsertErr);
          return NextResponse.json(
            { error: "Failed to set up AI opponent" },
            { status: 500 }
          );
        }
        await sb
          .from("players")
          .update({ ships_placed: true })
          .eq("id", aiPlayer.id);
      }
    }

    // Re-check both players: if both placed, transition to firing
    const { data: allPlayers } = await sb
      .from("players")
      .select("ships_placed, slot")
      .eq("game_id", gameId);

    const allReady =
      allPlayers && allPlayers.length === 2 && allPlayers.every((p) => p.ships_placed);

    if (allReady) {
      // Slot 1 fires first
      await sb
        .from("games")
        .update({ state: "firing", current_turn_slot: 1 })
        .eq("id", gameId);
    }

    await broadcastGameUpdate(gameId);

    return NextResponse.json({
      ok: true,
      both_placed: allReady,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
