import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import {
  byteaParam,
  generateRawToken,
  hashToken,
  parseBytea,
  verifyToken,
} from "@/lib/tokens";
import { errorResponse } from "@/lib/auth";
import { broadcastGameUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: gameId } = await params;
    const body = await req.json().catch(() => null);
    const inviteCode = body?.invite_code;

    if (!inviteCode || typeof inviteCode !== "string") {
      return NextResponse.json(
        { error: "invite_code required" },
        { status: 400 }
      );
    }

    const sb = adminClient();

    const { data: game, error: gameErr } = await sb
      .from("games")
      .select("id, mode, invite_code_hash, invite_used_at")
      .eq("id", gameId)
      .maybeSingle();

    if (gameErr) {
      console.error("[api/games/join] DB error:", gameErr);
      return NextResponse.json(
        { error: "Failed to load game" },
        { status: 500 }
      );
    }
    if (!game) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    if (game.mode !== "human") {
      return NextResponse.json(
        { error: "Not a multiplayer game" },
        { status: 400 }
      );
    }
    if (game.invite_used_at != null) {
      return NextResponse.json(
        { error: "Invite already used" },
        { status: 409 }
      );
    }

    const storedHash = parseBytea(game.invite_code_hash);
    if (!storedHash || !verifyToken(inviteCode, `invite:${gameId}`, storedHash)) {
      return NextResponse.json(
        { error: "Invalid invite code" },
        { status: 401 }
      );
    }

    const slot2Token = generateRawToken();
    const slot2Hash = hashToken(slot2Token, `player:${gameId}`);

    const { error: insertErr } = await sb.from("players").insert({
      game_id: gameId,
      slot: 2,
      is_ai: false,
      session_token_hash: byteaParam(slot2Hash),
    });

    if (insertErr) {
      // unique violation on (game_id, slot) → another client redeemed first
      if (insertErr.code === "23505") {
        return NextResponse.json(
          { error: "Slot 2 already filled" },
          { status: 409 }
        );
      }
      console.error("[api/games/join] insert failed:", insertErr);
      return NextResponse.json(
        { error: "Failed to join game" },
        { status: 500 }
      );
    }

    // Mark invite as used (CAS-style: only if still null)
    await sb
      .from("games")
      .update({ invite_used_at: new Date().toISOString() })
      .eq("id", gameId)
      .is("invite_used_at", null);

    await broadcastGameUpdate(gameId);

    return NextResponse.json({
      game_id: gameId,
      slot: 2,
      player_token: slot2Token,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
