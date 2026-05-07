import { NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase";
import { errorResponse } from "@/lib/auth";

// Public, read-only summary of completed games.
// No ship positions, no tokens — just outcome stats.
// Useful for: leaderboard / replay history / scalability demo.

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10), 1),
      100
    );

    const sb = adminClient();
    const { data: games, error } = await sb
      .from("games")
      .select(
        "id, mode, ai_difficulty, winner_slot, created_at, ended_at"
      )
      .eq("state", "ended")
      .order("ended_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[api/games/history] DB error:", error);
      return NextResponse.json(
        { error: "Failed to load history" },
        { status: 500 }
      );
    }

    // Augment with shot counts in one round-trip
    const gameIds = (games ?? []).map((g) => g.id);
    const shotCounts = new Map<string, number>();
    if (gameIds.length > 0) {
      const { data: shots } = await sb
        .from("shots")
        .select("game_id")
        .in("game_id", gameIds);
      for (const s of shots ?? []) {
        shotCounts.set(s.game_id, (shotCounts.get(s.game_id) ?? 0) + 1);
      }
    }

    const result = (games ?? []).map((g) => {
      const created = g.created_at ? new Date(g.created_at).getTime() : 0;
      const ended = g.ended_at ? new Date(g.ended_at).getTime() : 0;
      const durationSec = ended && created ? Math.round((ended - created) / 1000) : null;
      return {
        id: g.id,
        mode: g.mode,
        ai_difficulty: g.ai_difficulty,
        winner_slot: g.winner_slot,
        ended_at: g.ended_at,
        duration_seconds: durationSec,
        total_shots: shotCounts.get(g.id) ?? 0,
      };
    });

    return NextResponse.json({ games: result });
  } catch (err) {
    return errorResponse(err);
  }
}
