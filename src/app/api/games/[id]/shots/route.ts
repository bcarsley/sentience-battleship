import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import {
  authorizePlayer,
  errorResponse,
  readPlayerToken,
} from "@/lib/auth";
import { BOARD_SIZE, ShipType } from "@/lib/game-rules";
import { AIDifficulty, AIShotRecord } from "@/lib/ai";
import { pickAIShotAsync } from "@/lib/expert";
import { broadcastGameUpdate } from "@/lib/realtime";

type ShipRow = {
  id: string;
  ship_type: string;
  length: number;
  cells: Array<{ row: number; col: number }>;
  hit_cells: Array<{ row: number; col: number }>;
  sunk: boolean;
};

type ShotResolution = {
  shotId: string;
  result: "hit" | "miss" | "sunk";
  ship_type: ShipType | null;
  ship_id: string | null;
};

async function resolveShot(
  sb: ReturnType<typeof adminClient>,
  gameId: string,
  shooterPlayerId: string,
  targetPlayerId: string,
  row: number,
  col: number
): Promise<ShotResolution> {
  // Find target's ships
  const { data: ships } = await sb
    .from("ships")
    .select("id, ship_type, length, cells, hit_cells, sunk")
    .eq("player_id", targetPlayerId);

  let result: "hit" | "miss" | "sunk" = "miss";
  let ship_id: string | null = null;
  let ship_type: ShipType | null = null;

  if (ships) {
    for (const s of ships as unknown as ShipRow[]) {
      const hit = s.cells.some((c) => c.row === row && c.col === col);
      if (!hit) continue;
      ship_id = s.id;
      ship_type = s.ship_type as ShipType;
      const newHits = [...s.hit_cells, { row, col }];
      const sunk = newHits.length >= s.length;
      result = sunk ? "sunk" : "hit";
      await sb
        .from("ships")
        .update({ hit_cells: newHits, sunk })
        .eq("id", s.id);
      break;
    }
  }

  const { data: shotRow, error: insertErr } = await sb
    .from("shots")
    .insert({
      game_id: gameId,
      shooter_player_id: shooterPlayerId,
      target_row: row,
      target_col: col,
      result,
      ship_id,
    })
    .select("id")
    .single();

  if (insertErr || !shotRow) {
    throw new Error(`Failed to record shot: ${insertErr?.message ?? "unknown"}`);
  }

  return { shotId: shotRow.id, result, ship_type, ship_id };
}

async function endIfWon(
  sb: ReturnType<typeof adminClient>,
  gameId: string,
  shooterSlot: 1 | 2,
  targetPlayerId: string
): Promise<{ ended: boolean; winner_slot: 1 | 2 | null }> {
  const { data: ships } = await sb
    .from("ships")
    .select("sunk")
    .eq("player_id", targetPlayerId);

  const allSunk = ships && ships.length > 0 && ships.every((s) => s.sunk);
  if (!allSunk) return { ended: false, winner_slot: null };

  await sb
    .from("games")
    .update({
      state: "ended",
      winner_slot: shooterSlot,
      ended_at: new Date().toISOString(),
      current_turn_slot: null,
    })
    .eq("id", gameId);
  return { ended: true, winner_slot: shooterSlot };
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
    const row = body?.row;
    const col = body?.col;

    if (
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      row < 0 ||
      row >= BOARD_SIZE ||
      col < 0 ||
      col >= BOARD_SIZE
    ) {
      return NextResponse.json(
        { error: "row and col must be integers in [0,9]" },
        { status: 400 }
      );
    }

    const sb = adminClient();
    const oppSlot = (me.slot === 1 ? 2 : 1) as 1 | 2;

    // Atomic claim: pre-emptively swap current_turn_slot to opponent.
    // If 0 rows match (someone else claimed first, or game ended, or wrong phase),
    // we lose the race and 403. This makes the shot resolution exclusive.
    const { data: claimed, error: claimErr } = await sb
      .from("games")
      .update({ current_turn_slot: oppSlot })
      .eq("id", gameId)
      .eq("state", "firing")
      .eq("current_turn_slot", me.slot)
      .select("id, mode, ai_difficulty")
      .maybeSingle();

    if (claimErr) {
      console.error("[api/games/shots] turn claim DB error:", claimErr);
      return NextResponse.json(
        { error: "Failed to record shot" },
        { status: 500 }
      );
    }
    if (!claimed) {
      // Disambiguate the failure mode for the client
      const { data: probe } = await sb
        .from("games")
        .select("state, current_turn_slot")
        .eq("id", gameId)
        .maybeSingle();
      if (!probe) {
        return NextResponse.json({ error: "Game not found" }, { status: 404 });
      }
      if (probe.state !== "firing") {
        return NextResponse.json(
          { error: `Game is not in firing phase (state=${probe.state})` },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: "Not your turn" }, { status: 403 });
    }

    const game = claimed;

    // Find opponent
    const { data: opponentRow } = await sb
      .from("players")
      .select("id, slot, is_ai")
      .eq("game_id", gameId)
      .neq("slot", me.slot)
      .single();

    if (!opponentRow) {
      // Roll back the claim — game is corrupt
      await sb
        .from("games")
        .update({ current_turn_slot: me.slot })
        .eq("id", gameId);
      return NextResponse.json(
        { error: "Opponent not found" },
        { status: 500 }
      );
    }

    // Check duplicate shot
    const { data: existing } = await sb
      .from("shots")
      .select("id")
      .eq("game_id", gameId)
      .eq("shooter_player_id", me.id)
      .eq("target_row", row)
      .eq("target_col", col)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: "Already shot at this cell" },
        { status: 409 }
      );
    }

    // Resolve human shot. Turn is already advanced to opponent by the claim above,
    // so we only need to check win → end game.
    const myShot = await resolveShot(sb, gameId, me.id, opponentRow.id, row, col);
    const post = await endIfWon(sb, gameId, me.slot, opponentRow.id);

    let aiShot: (ShotResolution & { row: number; col: number }) | null = null;
    let postAi: { ended: boolean; winner_slot: 1 | 2 | null } | null = null;

    // vs-AI: AI takes its shot immediately (only if game not over)
    if (!post.ended && game.mode === "ai" && opponentRow.is_ai) {
      // Opponent (AI) is about to fire on us
      const { data: aiPriorShots } = await sb
        .from("shots")
        .select("target_row, target_col, result, ship_id")
        .eq("game_id", gameId)
        .eq("shooter_player_id", opponentRow.id)
        .order("shot_at", { ascending: true });

      // For ship_type lookup on prior AI hits, fetch our ships
      const { data: ourShips } = await sb
        .from("ships")
        .select("id, ship_type, sunk")
        .eq("player_id", me.id);

      const shipById = new Map<string, { ship_type: string; sunk: boolean }>();
      (ourShips ?? []).forEach((s) => shipById.set(s.id, s));

      const aiHistory: AIShotRecord[] = (aiPriorShots ?? []).map((s) => ({
        row: s.target_row,
        col: s.target_col,
        result: s.result as "hit" | "miss" | "sunk",
        ship_type: (s.ship_id && shipById.get(s.ship_id)?.ship_type) as ShipType | undefined,
      }));

      const remainingShipTypes = (ourShips ?? [])
        .filter((s) => !s.sunk)
        .map((s) => s.ship_type as ShipType);

      const aiCell = await pickAIShotAsync(
        (game.ai_difficulty ?? "easy") as AIDifficulty,
        aiHistory,
        remainingShipTypes
      );

      const aiResolution = await resolveShot(
        sb,
        gameId,
        opponentRow.id,
        me.id,
        aiCell.row,
        aiCell.col
      );

      aiShot = { ...aiResolution, row: aiCell.row, col: aiCell.col };

      postAi = await endIfWon(sb, gameId, opponentRow.slot as 1 | 2, me.id);

      // If AI didn't win, advance turn back to human (we're currently on AI's slot from the claim).
      if (!postAi.ended) {
        await sb
          .from("games")
          .update({ current_turn_slot: me.slot })
          .eq("id", gameId);
      }
    }

    await broadcastGameUpdate(gameId);

    // Only reveal ship_type on sunk — non-sunk hits should not leak which ship was struck.
    return NextResponse.json({
      my_shot: {
        row,
        col,
        result: myShot.result,
        ship_type: myShot.result === "sunk" ? myShot.ship_type : null,
      },
      ai_shot: aiShot
        ? {
            row: aiShot.row,
            col: aiShot.col,
            result: aiShot.result,
            ship_type: aiShot.result === "sunk" ? aiShot.ship_type : null,
          }
        : null,
      ended: postAi?.ended ?? post.ended,
      winner_slot: postAi?.winner_slot ?? post.winner_slot,
      // vs-AI: turn returns to human (AI just fired). vs-Human: opponent has the turn (claim swapped).
      current_turn_slot:
        post.ended || postAi?.ended
          ? null
          : game.mode === "ai"
          ? me.slot
          : oppSlot,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
