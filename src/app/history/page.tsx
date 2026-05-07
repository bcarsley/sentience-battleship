"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type GameSummary = {
  id: string;
  mode: "ai" | "human";
  ai_difficulty: "easy" | "medium" | "hard" | "expert" | null;
  winner_slot: 1 | 2 | null;
  ended_at: string | null;
  duration_seconds: number | null;
  total_shots: number;
};

export default function HistoryPage() {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/games/history?limit=50")
      .then((r) => r.json())
      .then((d) => setGames(d.games ?? []))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="min-h-screen p-6 md:p-10 bg-gradient-to-br from-sky-50 via-cyan-50 to-blue-100 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-baseline mb-6">
          <h1 className="text-3xl font-bold tracking-tight">
            ⚓ Recent games
          </h1>
          <Link
            href="/"
            className="text-sm opacity-60 hover:opacity-100"
          >
            ← Menu
          </Link>
        </div>

        {error && <div className="text-red-500 text-sm mb-4">{error}</div>}

        {!games && !error && <div className="opacity-70">Loading…</div>}

        {games && games.length === 0 && (
          <div className="text-center py-16 opacity-70">
            <div className="text-4xl mb-3">🌊</div>
            No games have finished yet.
          </div>
        )}

        {games && games.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-cyan-700/20 dark:border-cyan-300/10 bg-white/60 dark:bg-slate-900/60 backdrop-blur">
            <table className="w-full text-sm">
              <thead className="bg-cyan-700/10 dark:bg-cyan-300/5 text-left text-xs uppercase tracking-wider opacity-70">
                <tr>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Difficulty</th>
                  <th className="px-4 py-3">Winner</th>
                  <th className="px-4 py-3 text-right">Shots</th>
                  <th className="px-4 py-3 text-right">Duration</th>
                  <th className="px-4 py-3">Ended</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {games.map((g) => (
                  <tr
                    key={g.id}
                    className="border-t border-cyan-700/10 dark:border-cyan-300/5 hover:bg-cyan-700/5 dark:hover:bg-cyan-300/5"
                  >
                    <td className="px-4 py-3">
                      {g.mode === "ai" ? "vs AI" : "Multiplayer"}
                    </td>
                    <td className="px-4 py-3 opacity-80">
                      {g.ai_difficulty ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {g.winner_slot ? `Slot ${g.winner_slot}` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {g.total_shots}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {g.duration_seconds != null ? `${g.duration_seconds}s` : "—"}
                    </td>
                    <td className="px-4 py-3 opacity-70 text-xs">
                      {g.ended_at
                        ? new Date(g.ended_at).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/history/${g.id}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        View moves →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs opacity-60">
          Public, anonymous summary. No player identifiers stored or returned.
          Programmatic access:{" "}
          <code className="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 rounded">
            GET /api/games/history?limit=N
          </code>
        </p>
      </div>
    </main>
  );
}
