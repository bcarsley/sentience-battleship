import { NextResponse } from "next/server";
import { adminClient } from "./supabase";
import { verifyToken, parseBytea } from "./tokens";

export type AuthorizedPlayer = {
  id: string;
  game_id: string;
  slot: 1 | 2;
  is_ai: boolean;
  ships_placed: boolean;
};

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export function readPlayerToken(req: Request): string | null {
  return req.headers.get("x-player-token");
}

export async function authorizePlayer(
  gameId: string,
  rawToken: string | null
): Promise<AuthorizedPlayer> {
  if (!rawToken) throw new AuthError(401, "Missing X-Player-Token header");

  const sb = adminClient();
  const { data: players, error } = await sb
    .from("players")
    .select("id, game_id, slot, is_ai, ships_placed, session_token_hash")
    .eq("game_id", gameId)
    .eq("is_ai", false);

  if (error) {
    console.error("[auth] DB error during authorization:", error);
    throw new AuthError(500, "Authorization failed");
  }
  if (!players || players.length === 0) {
    throw new AuthError(404, "Game not found");
  }

  const scope = `player:${gameId}`;
  for (const p of players) {
    const stored = parseBytea(p.session_token_hash);
    if (!stored) continue;
    if (verifyToken(rawToken, scope, stored)) {
      return {
        id: p.id,
        game_id: p.game_id,
        slot: p.slot as 1 | 2,
        is_ai: p.is_ai,
        ships_placed: p.ships_placed,
      };
    }
  }
  throw new AuthError(401, "Invalid token");
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[api] unhandled error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
