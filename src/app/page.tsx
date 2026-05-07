"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Difficulty = "easy" | "medium" | "hard" | "expert";

export default function Home() {
  const router = useRouter();
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createGame(mode: "ai" | "human") {
    setBusy(true);
    setError(null);
    try {
      const body = mode === "ai" ? { mode, ai_difficulty: difficulty } : { mode };
      const resp = await fetch("/api/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Failed to create game");
        return;
      }
      const { game_id, player_token, invite_code } = data;
      localStorage.setItem(`bs:${game_id}:token`, player_token);
      localStorage.setItem(`bs:${game_id}:slot`, "1");
      const url = invite_code
        ? `/g/${game_id}?host=1&invite=${invite_code}`
        : `/g/${game_id}`;
      router.push(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        <h1 className="text-4xl font-bold mb-2">Battleship</h1>
        <p className="text-sm opacity-70 mb-8">
          Server-authoritative · Bayesian-optimum AI · onnxruntime-web compatible
        </p>

        <div className="border rounded-lg p-6 mb-4">
          <h2 className="text-xl font-semibold mb-3">Single-player vs AI</h2>
          <label className="block text-sm mb-2">Difficulty</label>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className="w-full p-2 border rounded mb-4 bg-transparent"
          >
            <option value="easy">Easy — uniform random</option>
            <option value="medium">Medium — hunt &amp; target</option>
            <option value="hard">Hard — Bayesian probability density</option>
            <option value="expert">Expert — neural net (trained on Hard)</option>
          </select>
          <button
            onClick={() => createGame("ai")}
            disabled={busy}
            className="w-full py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Start vs-AI game
          </button>
        </div>

        <div className="border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-3">Multiplayer</h2>
          <p className="text-sm opacity-70 mb-4">
            Creates a private game with a shareable invite link.
          </p>
          <button
            onClick={() => createGame("human")}
            disabled={busy}
            className="w-full py-2 rounded border hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Create multiplayer game
          </button>
        </div>

        {error && <div className="mt-4 text-red-500 text-sm">{error}</div>}

        <div className="mt-6 text-center">
          <Link
            href="/history"
            className="text-sm opacity-60 hover:opacity-100 underline-offset-4 hover:underline"
          >
            Recent games →
          </Link>
        </div>
      </div>
    </main>
  );
}
