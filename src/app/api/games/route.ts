import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import {
  byteaParam,
  generateInviteCode,
  generateRawToken,
  hashToken,
} from "@/lib/tokens";
import { errorResponse } from "@/lib/auth";

const VALID_DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
type Difficulty = (typeof VALID_DIFFICULTIES)[number];

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const mode = body?.mode;
    const ai_difficulty = body?.ai_difficulty as Difficulty | undefined;

    if (mode !== "ai" && mode !== "human") {
      return NextResponse.json(
        { error: "mode must be 'ai' or 'human'" },
        { status: 400 }
      );
    }

    if (mode === "ai") {
      if (
        !ai_difficulty ||
        !VALID_DIFFICULTIES.includes(ai_difficulty)
      ) {
        return NextResponse.json(
          {
            error:
              "ai_difficulty required for vs-AI; must be one of " +
              VALID_DIFFICULTIES.join(", "),
          },
          { status: 400 }
        );
      }
    } else if (ai_difficulty != null) {
      return NextResponse.json(
        { error: "ai_difficulty must not be set for vs-Human" },
        { status: 400 }
      );
    }

    const sb = adminClient();

    const slot1Token = generateRawToken();
    const inviteCode = mode === "human" ? generateInviteCode() : null;

    // Insert game first so we have the gameId to scope token hashes against.
    const { data: gameRow, error: gameErr } = await sb
      .from("games")
      .insert({
        mode,
        state: "placing",
        ai_difficulty: mode === "ai" ? ai_difficulty! : null,
        // invite_code_hash filled in once we have gameId
        invite_code_hash: null,
      })
      .select("id")
      .single();

    if (gameErr || !gameRow) {
      console.error("[api/games] create failed:", gameErr);
      return NextResponse.json(
        { error: "Failed to create game" },
        { status: 500 }
      );
    }

    const gameId = gameRow.id;
    const slot1Hash = hashToken(slot1Token, `player:${gameId}`);

    if (inviteCode) {
      await sb
        .from("games")
        .update({
          invite_code_hash: byteaParam(hashToken(inviteCode, `invite:${gameId}`)),
        })
        .eq("id", gameId);
    }

    const playersToInsert: Array<{
      game_id: string;
      slot: number;
      is_ai: boolean;
      session_token_hash: string | null;
    }> = [
      {
        game_id: gameId,
        slot: 1,
        is_ai: false,
        session_token_hash: byteaParam(slot1Hash),
      },
    ];
    if (mode === "ai") {
      playersToInsert.push({
        game_id: gameId,
        slot: 2,
        is_ai: true,
        session_token_hash: null,
      });
    }

    const { error: playersErr } = await sb
      .from("players")
      .insert(playersToInsert);

    if (playersErr) {
      console.error("[api/games] players insert failed:", playersErr);
      await sb.from("games").delete().eq("id", gameId);
      return NextResponse.json(
        { error: "Failed to create game" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      game_id: gameId,
      slot: 1,
      player_token: slot1Token,
      ...(inviteCode ? { invite_code: inviteCode } : {}),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
