"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";

const COL_LABELS = "ABCDEFGHIJ".split("");

type Move = {
  shooter_slot: 1 | 2 | null;
  shooter_is_ai: boolean;
  row: number;
  col: number;
  result: "hit" | "miss" | "sunk";
  ship_type: string | null;
  shot_at: string;
};

type Replay = {
  game: {
    id: string;
    mode: "ai" | "human";
    ai_difficulty: "easy" | "medium" | "hard" | "expert" | null;
    winner_slot: 1 | 2 | null;
    created_at: string;
    ended_at: string;
    duration_seconds: number | null;
  };
  total_moves: number;
  moves: Move[];
};

export default function ReplayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/games/${id}/replay`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: Replay) => setReplay(d))
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  return (
    <main className="min-h-screen p-6 md:p-10 bg-gradient-to-br from-sky-50 via-cyan-50 to-blue-100 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <div className="max-w-3xl mx-auto">
        <div className="flex justify-between items-baseline mb-6">
          <h1 className="text-2xl font-bold tracking-tight">⚓ Game replay</h1>
          <Link
            href="/history"
            className="text-sm opacity-60 hover:opacity-100"
          >
            ← History
          </Link>
        </div>

        {error && (
          <div className="p-4 rounded border bg-rose-50 dark:bg-rose-950/40 text-sm">
            {error}
          </div>
        )}

        {!replay && !error && <div className="opacity-70">Loading…</div>}

        {replay && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 text-sm">
              <Stat label="Mode">
                {replay.game.mode === "ai" ? "vs AI" : "Multiplayer"}
              </Stat>
              <Stat label="Difficulty">{replay.game.ai_difficulty ?? "—"}</Stat>
              <Stat label="Winner">
                {replay.game.winner_slot
                  ? `Slot ${replay.game.winner_slot}`
                  : "—"}
              </Stat>
              <Stat label="Duration">
                {replay.game.duration_seconds != null
                  ? `${replay.game.duration_seconds}s`
                  : "—"}
              </Stat>
            </div>

            <div className="rounded-lg border border-cyan-700/20 dark:border-cyan-300/10 bg-white/60 dark:bg-slate-900/60 backdrop-blur overflow-hidden">
              <div className="px-4 py-2 text-xs uppercase tracking-wider opacity-70 bg-cyan-700/10 dark:bg-cyan-300/5">
                Move sequence ({replay.total_moves})
              </div>
              <ol className="divide-y divide-cyan-700/10 dark:divide-cyan-300/5">
                {replay.moves.map((m, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-3 px-4 py-2 text-sm font-mono"
                  >
                    <span className="opacity-50 w-8 text-right">{i + 1}.</span>
                    <span className="w-20 opacity-80">
                      {m.shooter_is_ai ? "AI" : `Slot ${m.shooter_slot}`}
                    </span>
                    <span className="w-12">
                      {COL_LABELS[m.col]}
                      {m.row + 1}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        m.result === "sunk"
                          ? "bg-rose-900 text-white"
                          : m.result === "hit"
                          ? "bg-rose-600 text-white"
                          : "bg-zinc-300 dark:bg-zinc-700"
                      }`}
                    >
                      {m.result}
                    </span>
                    {m.ship_type && (
                      <span className="opacity-70 text-xs">
                        sunk {m.ship_type}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>

            <p className="mt-4 text-xs opacity-60">
              Programmatic access:{" "}
              <code className="font-mono bg-zinc-200 dark:bg-zinc-800 px-1 rounded">
                GET /api/games/{id}/replay
              </code>
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-cyan-700/20 dark:border-cyan-300/10 bg-white/60 dark:bg-slate-900/60 backdrop-blur p-3">
      <div className="text-[0.65rem] uppercase tracking-wider opacity-60 mb-0.5">
        {label}
      </div>
      <div className="font-medium">{children}</div>
    </div>
  );
}
