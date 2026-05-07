"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@supabase/supabase-js";

const BOARD_SIZE = 10;

type ShipType = "carrier" | "battleship" | "cruiser" | "submarine" | "destroyer";
type Orientation = "horizontal" | "vertical";
type Cell = { row: number; col: number };
type Placement = {
  ship_type: ShipType;
  row: number;
  col: number;
  orientation: Orientation;
};

const SHIP_SIZES: Record<ShipType, number> = {
  carrier: 5,
  battleship: 4,
  cruiser: 3,
  submarine: 3,
  destroyer: 2,
};
const SHIP_TYPES: ShipType[] = [
  "carrier",
  "battleship",
  "cruiser",
  "submarine",
  "destroyer",
];

const SHIP_COLORS: Record<ShipType, { ship: string; ring: string; light: string }> = {
  carrier:    { ship: "bg-indigo-700",  ring: "ring-indigo-400",  light: "bg-indigo-300" },
  battleship: { ship: "bg-teal-700",    ring: "ring-teal-400",    light: "bg-teal-300" },
  cruiser:    { ship: "bg-amber-700",   ring: "ring-amber-400",   light: "bg-amber-300" },
  submarine:  { ship: "bg-violet-700",  ring: "ring-violet-400",  light: "bg-violet-300" },
  destroyer:  { ship: "bg-rose-700",    ring: "ring-rose-400",    light: "bg-rose-300" },
};

const COL_LABELS = "ABCDEFGHIJ".split("");

type GameState = {
  game: {
    id: string;
    mode: "ai" | "human";
    state: "placing" | "firing" | "ended";
    current_turn_slot: 1 | 2 | null;
    winner_slot: 1 | 2 | null;
    ai_difficulty: "easy" | "medium" | "hard" | "expert" | null;
  };
  me: {
    slot: 1 | 2;
    ships_placed: boolean;
    ships: Array<{
      ship_type: string;
      length: number;
      cells: Cell[];
      hit_cells: Cell[];
      sunk: boolean;
    }>;
  };
  opponent: {
    slot: 1 | 2;
    is_ai: boolean;
    ships_placed: boolean;
    sunk_ship_types: ShipType[];
  } | null;
  shots: {
    mine: Array<{
      row: number;
      col: number;
      result: "hit" | "miss" | "sunk";
      ship_type: ShipType | null;
    }>;
    theirs: Array<{
      row: number;
      col: number;
      result: "hit" | "miss" | "sunk";
    }>;
  };
};

function expandPlacement(p: Placement): Cell[] {
  const len = SHIP_SIZES[p.ship_type];
  const cells: Cell[] = [];
  for (let i = 0; i < len; i++) {
    cells.push({
      row: p.row + (p.orientation === "vertical" ? i : 0),
      col: p.col + (p.orientation === "horizontal" ? i : 0),
    });
  }
  return cells;
}

function inBounds(c: Cell): boolean {
  return c.row >= 0 && c.row < BOARD_SIZE && c.col >= 0 && c.col < BOARD_SIZE;
}

function isValidPlacement(p: Placement, others: Placement[]): boolean {
  const cells = expandPlacement(p);
  if (!cells.every(inBounds)) return false;
  const occ = new Set(
    others.flatMap(expandPlacement).map((c) => `${c.row},${c.col}`)
  );
  return cells.every((c) => !occ.has(`${c.row},${c.col}`));
}

function randomPlacements(): Placement[] {
  for (let restart = 0; restart < 50; restart++) {
    const result: Placement[] = [];
    let ok = true;
    for (const t of SHIP_TYPES) {
      let placed = false;
      for (let i = 0; i < 500 && !placed; i++) {
        const orientation: Orientation =
          Math.random() < 0.5 ? "horizontal" : "vertical";
        const row = Math.floor(Math.random() * BOARD_SIZE);
        const col = Math.floor(Math.random() * BOARD_SIZE);
        const candidate: Placement = { ship_type: t, row, col, orientation };
        if (isValidPlacement(candidate, result)) {
          result.push(candidate);
          placed = true;
        }
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return result;
  }
  return [];
}

export default function GameClient({
  gameId,
  inviteCode,
  isHost,
}: {
  gameId: string;
  inviteCode: string | null;
  isHost: boolean;
}) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Placement
  const [placements, setPlacements] = useState<Placement[]>([]);
  const [activeShip, setActiveShip] = useState<ShipType | null>("carrier");
  const [orientation, setOrientation] = useState<Orientation>("horizontal");
  const [hover, setHover] = useState<Cell | null>(null);

  // Firing
  const [firing, setFiring] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  // UX
  const [copied, setCopied] = useState(false);

  // Bootstrap token
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored =
        typeof window !== "undefined"
          ? localStorage.getItem(`bs:${gameId}:token`)
          : null;
      if (stored) {
        if (!cancelled) setToken(stored);
        return;
      }
      if (!inviteCode) {
        if (!cancelled) {
          setError("This game requires an invite link from the host.");
          setLoading(false);
        }
        return;
      }
      try {
        const resp = await fetch(`/api/games/${gameId}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invite_code: inviteCode }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          if (!cancelled) {
            setError(data.error || "Failed to join");
            setLoading(false);
          }
          return;
        }
        localStorage.setItem(`bs:${gameId}:token`, data.player_token);
        localStorage.setItem(`bs:${gameId}:slot`, String(data.slot));
        if (!cancelled) {
          setToken(data.player_token);
          router.replace(`/g/${gameId}`);
        }
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, inviteCode, router]);

  // Fetch + poll
  const fetchState = useCallback(async () => {
    if (!token) return;
    try {
      const resp = await fetch(`/api/games/${gameId}`, {
        headers: { "X-Player-Token": token },
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Failed to fetch state");
        return;
      }
      setState(data);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [gameId, token]);

  // Initial fetch + slow fallback poll (every 10s) in case a broadcast is dropped.
  // The setState calls inside fetchState happen after `await` — async, not synchronous.
  useEffect(() => {
    if (!token) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchState();
    const id = setInterval(() => void fetchState(), 10000);
    return () => clearInterval(id);
  }, [fetchState, token]);

  // Realtime: subscribe to game:<id> broadcasts and refetch on receipt.
  useEffect(() => {
    if (!token) return;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    const sb = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const channel = sb.channel(`game:${gameId}`);
    channel.on("broadcast", { event: "update" }, () => {
      fetchState();
    });
    channel.subscribe();
    return () => {
      sb.removeChannel(channel);
    };
  }, [fetchState, gameId, token]);

  // Keyboard: R rotates during placement
  useEffect(() => {
    if (!state || state.game.state !== "placing" || state.me.ships_placed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "r" || e.key === "R") {
        setOrientation((o) => (o === "horizontal" ? "vertical" : "horizontal"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  function nextUnplaced(after: Placement[]): ShipType | null {
    return SHIP_TYPES.find((t) => !after.some((p) => p.ship_type === t)) ?? null;
  }

  function placeOnGrid(row: number, col: number) {
    if (!activeShip) {
      // Click on placed ship to pick it up
      const here = placements.find((p) =>
        expandPlacement(p).some((c) => c.row === row && c.col === col)
      );
      if (here) {
        setPlacements(placements.filter((p) => p.ship_type !== here.ship_type));
        setActiveShip(here.ship_type);
        setOrientation(here.orientation);
      }
      return;
    }
    const others = placements.filter((p) => p.ship_type !== activeShip);
    const candidate: Placement = {
      ship_type: activeShip,
      row,
      col,
      orientation,
    };
    if (!isValidPlacement(candidate, others)) {
      // If the cell already has a placed ship, pick that up instead
      const here = placements.find((p) =>
        expandPlacement(p).some((c) => c.row === row && c.col === col)
      );
      if (here && here.ship_type !== activeShip) {
        setPlacements(placements.filter((p) => p.ship_type !== here.ship_type));
        setActiveShip(here.ship_type);
        setOrientation(here.orientation);
      }
      return;
    }
    const next = [...others, candidate];
    setPlacements(next);
    setActiveShip(nextUnplaced(next));
  }

  async function confirmPlacements() {
    if (placements.length !== SHIP_TYPES.length || !token) return;
    try {
      const resp = await fetch(`/api/games/${gameId}/ships`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Player-Token": token,
        },
        body: JSON.stringify({ placements }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Failed to place ships");
        return;
      }
      setPlacements([]);
      fetchState();
    } catch (e) {
      setError(String(e));
    }
  }

  async function fireShot(row: number, col: number) {
    if (!token || firing || !state) return;
    if (state.game.state !== "firing") return;
    if (state.game.current_turn_slot !== state.me.slot) return;
    if (state.shots.mine.some((s) => s.row === row && s.col === col)) return;
    setFiring(true);
    try {
      const resp = await fetch(`/api/games/${gameId}/shots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Player-Token": token,
        },
        body: JSON.stringify({ row, col }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setError(data.error || "Failed to fire");
        setFiring(false);
        return;
      }
      const parts: string[] = [];
      const my = data.my_shot;
      const myLabel =
        my.result === "sunk" && my.ship_type
          ? `sunk ${my.ship_type}`
          : my.result;
      parts.push(`${COL_LABELS[my.col]}${my.row + 1}: ${myLabel}`);
      if (data.ai_shot) {
        const ai = data.ai_shot;
        const aiLabel =
          ai.result === "sunk" && ai.ship_type
            ? `sunk your ${ai.ship_type}`
            : ai.result;
        parts.push(
          `AI fires ${COL_LABELS[ai.col]}${ai.row + 1}: ${aiLabel}`
        );
      }
      setLastResult(parts.join(" • "));
      fetchState();
    } catch (e) {
      setError(String(e));
    } finally {
      setFiring(false);
    }
  }

  if (loading || !state) {
    return (
      <main className="min-h-screen p-8 flex items-center justify-center bg-gradient-to-br from-sky-50 via-cyan-50 to-blue-100 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
        <div className="text-center max-w-md">
          {error ? (
            <>
              <div className="text-5xl mb-3">🏝</div>
              <h2 className="text-xl font-semibold mb-2">Game unavailable</h2>
              <p className="text-sm opacity-70 mb-6">{error}</p>
              <button
                onClick={() => router.push("/")}
                className="px-5 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Back to menu
              </button>
            </>
          ) : (
            <div className="opacity-70">Loading…</div>
          )}
        </div>
      </main>
    );
  }

  const inviteUrl =
    inviteCode && typeof window !== "undefined"
      ? `${window.location.origin}/g/${gameId}?invite=${inviteCode}`
      : null;

  const myTurn =
    state.game.state === "firing" &&
    state.game.current_turn_slot === state.me.slot;

  return (
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-sky-50 via-cyan-50 to-blue-100 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-baseline mb-6">
          <h1 className="text-3xl font-bold tracking-tight">
            ⚓ Battleship
            <span className="ml-3 text-sm font-normal opacity-60">
              {state.game.mode === "ai"
                ? `vs AI · ${state.game.ai_difficulty}`
                : "Multiplayer"}
            </span>
          </h1>
          <button
            onClick={() => router.push("/")}
            className="text-sm opacity-60 hover:opacity-100"
          >
            ← Menu
          </button>
        </div>

        {error && <div className="text-red-500 mb-2 text-sm">{error}</div>}

        {state.game.state === "placing" &&
          state.game.mode === "human" &&
          !state.opponent &&
          isHost &&
          inviteUrl && (
            <div className="mb-6 p-4 border rounded-lg bg-amber-50/80 dark:bg-amber-950/40 backdrop-blur">
              <p className="mb-2 text-sm font-medium">
                Share with your opponent
              </p>
              <div className="flex gap-2">
                <input
                  value={inviteUrl}
                  readOnly
                  className="flex-1 p-2 border rounded text-xs bg-white dark:bg-black"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(inviteUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="px-3 py-1 border rounded text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors min-w-20"
                >
                  {copied ? "✓ Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

        {state.game.state === "placing" && !state.me.ships_placed && (
          <PlacementUI
            placements={placements}
            activeShip={activeShip}
            setActiveShip={setActiveShip}
            orientation={orientation}
            setOrientation={setOrientation}
            hover={hover}
            setHover={setHover}
            onPlaceCell={placeOnGrid}
            onRandomize={() => {
              setPlacements(randomPlacements());
              setActiveShip(null);
            }}
            onConfirm={confirmPlacements}
            onClear={() => {
              setPlacements([]);
              setActiveShip("carrier");
            }}
          />
        )}

        {state.game.state === "placing" && state.me.ships_placed && (
          <div className="p-12 text-center opacity-70">
            <div className="text-2xl mb-2">⏳</div>
            Waiting for opponent to place their ships…
          </div>
        )}

        {state.game.state === "firing" && (
          <FiringUI
            state={state}
            myTurn={myTurn}
            onFire={fireShot}
            firing={firing}
            lastResult={lastResult}
          />
        )}

        {state.game.state === "ended" && (
          <div className="text-center py-16">
            <h2 className="text-5xl font-bold mb-4">
              {state.game.winner_slot === state.me.slot
                ? "🏆 You win"
                : "💀 You lost"}
            </h2>
            <p className="opacity-70 mb-8">
              {state.shots.mine.length} shots fired ·{" "}
              {state.shots.mine.filter((s) => s.result !== "miss").length} hits
            </p>
            <div className="flex gap-3 justify-center">
              {state.game.mode === "ai" && (
                <button
                  onClick={async () => {
                    const resp = await fetch("/api/games", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        mode: "ai",
                        ai_difficulty: state.game.ai_difficulty,
                      }),
                    });
                    const data = await resp.json();
                    if (!resp.ok) {
                      setError(data.error || "Failed to create rematch");
                      return;
                    }
                    localStorage.setItem(
                      `bs:${data.game_id}:token`,
                      data.player_token
                    );
                    localStorage.setItem(`bs:${data.game_id}:slot`, "1");
                    router.push(`/g/${data.game_id}`);
                  }}
                  className="px-6 py-3 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  Play again ({state.game.ai_difficulty})
                </button>
              )}
              <button
                onClick={() => router.push("/")}
                className="px-6 py-3 rounded-lg border hover:bg-zinc-100 dark:hover:bg-zinc-900 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                Menu
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// =====================================================================
// PlacementUI
// =====================================================================
function PlacementUI({
  placements,
  activeShip,
  setActiveShip,
  orientation,
  setOrientation,
  hover,
  setHover,
  onPlaceCell,
  onRandomize,
  onConfirm,
  onClear,
}: {
  placements: Placement[];
  activeShip: ShipType | null;
  setActiveShip: (s: ShipType | null) => void;
  orientation: Orientation;
  setOrientation: (o: Orientation) => void;
  hover: Cell | null;
  setHover: (c: Cell | null) => void;
  onPlaceCell: (row: number, col: number) => void;
  onRandomize: () => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  // Build maps for quick rendering
  const placedByCell = new Map<string, ShipType>();
  for (const p of placements) {
    for (const c of expandPlacement(p)) {
      placedByCell.set(`${c.row},${c.col}`, p.ship_type);
    }
  }

  // Preview cells for current hover + active ship
  let previewCells: Cell[] = [];
  let previewValid = false;
  if (activeShip && hover) {
    const candidate: Placement = {
      ship_type: activeShip,
      row: hover.row,
      col: hover.col,
      orientation,
    };
    previewCells = expandPlacement(candidate);
    const others = placements.filter((p) => p.ship_type !== activeShip);
    const otherCells = new Set(
      others.flatMap(expandPlacement).map((o) => `${o.row},${o.col}`)
    );
    previewValid =
      previewCells.every(inBounds) &&
      previewCells.every((c) => !otherCells.has(`${c.row},${c.col}`));
  }
  const previewSet = new Set(previewCells.map((c) => `${c.row},${c.col}`));
  const allPlaced = placements.length === SHIP_TYPES.length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px,1fr] gap-6">
      {/* Ship dock */}
      <aside>
        <h3 className="font-semibold mb-3 text-sm uppercase tracking-wider opacity-70">
          Your fleet
        </h3>
        <ul className="space-y-2 mb-5">
          {SHIP_TYPES.map((t) => {
            const placed = placements.some((p) => p.ship_type === t);
            const isActive = activeShip === t;
            const c = SHIP_COLORS[t];
            return (
              <li key={t}>
                <button
                  onClick={() => setActiveShip(t)}
                  className={`w-full flex items-center gap-3 p-2 rounded-lg border transition ${
                    isActive
                      ? `${c.ring} ring-2 border-transparent bg-white/80 dark:bg-slate-800/80`
                      : "border-zinc-200 dark:border-slate-700 hover:bg-white/60 dark:hover:bg-slate-800/60"
                  } ${placed && !isActive ? "opacity-50" : ""}`}
                >
                  <div className="flex gap-0.5">
                    {Array.from({ length: SHIP_SIZES[t] }).map((_, i) => (
                      <div
                        key={i}
                        className={`w-3 h-3 rounded-sm ${c.ship}`}
                      />
                    ))}
                  </div>
                  <span className="text-sm capitalize flex-1 text-left">{t}</span>
                  {placed && (
                    <span className="text-xs opacity-60">
                      {isActive ? "moving" : "placed"}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex gap-2 flex-wrap mb-3">
          <button
            onClick={() =>
              setOrientation(orientation === "horizontal" ? "vertical" : "horizontal")
            }
            className="px-3 py-2 border rounded text-sm hover:bg-white/60 dark:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title="Or press R"
          >
            Rotate · {orientation === "horizontal" ? "—" : "|"} (R)
          </button>
          <button
            onClick={onRandomize}
            className="px-3 py-2 border rounded text-sm hover:bg-white/60 dark:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Randomize
          </button>
          <button
            onClick={onClear}
            className="px-3 py-2 border rounded text-sm hover:bg-white/60 dark:hover:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Clear
          </button>
        </div>
        <button
          onClick={onConfirm}
          disabled={!allPlaced}
          className="w-full py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          {allPlaced ? "Confirm placement" : `Place ${SHIP_TYPES.length - placements.length} more`}
        </button>
        <p className="text-xs opacity-60 mt-3">
          Tip: click a placed ship on the grid to pick it up and reposition.
        </p>
      </aside>

      {/* Placement grid */}
      <div onMouseLeave={() => setHover(null)}>
        <Grid
          renderCell={(row, col) => {
            const here = placedByCell.get(`${row},${col}`);
            const inPreview = previewSet.has(`${row},${col}`);
            const c = here ? SHIP_COLORS[here] : null;
            return (
              <button
                onMouseEnter={() => setHover({ row, col })}
                onClick={() => onPlaceCell(row, col)}
                className={`w-full h-full ${
                  here
                    ? `${c!.ship}`
                    : inPreview
                    ? previewValid
                      ? "bg-emerald-300/70 dark:bg-emerald-700/60"
                      : "bg-rose-400/70 dark:bg-rose-700/60"
                    : "bg-cyan-50 hover:bg-cyan-100 dark:bg-slate-900 dark:hover:bg-slate-800"
                }`}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

// =====================================================================
// FiringUI
// =====================================================================
function FiringUI({
  state,
  myTurn,
  onFire,
  firing,
  lastResult,
}: {
  state: GameState;
  myTurn: boolean;
  onFire: (row: number, col: number) => void;
  firing: boolean;
  lastResult: string | null;
}) {
  const myShipCells = new Map<string, { type: ShipType; sunk: boolean }>();
  const myHitCells = new Set<string>();
  for (const s of state.me.ships) {
    for (const c of s.cells) {
      myShipCells.set(`${c.row},${c.col}`, {
        type: s.ship_type as ShipType,
        sunk: s.sunk,
      });
    }
    for (const c of s.hit_cells) {
      myHitCells.add(`${c.row},${c.col}`);
    }
  }
  const theirMisses = new Set(
    state.shots.theirs
      .filter((s) => s.result === "miss")
      .map((s) => `${s.row},${s.col}`)
  );

  const myShotsMap = new Map<string, "hit" | "miss" | "sunk">();
  for (const s of state.shots.mine) {
    myShotsMap.set(`${s.row},${s.col}`, s.result);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <span
          className={`inline-block px-4 py-1.5 rounded-full text-sm font-medium ${
            myTurn
              ? "bg-emerald-600 text-white"
              : "bg-zinc-200 dark:bg-slate-800"
          }`}
        >
          {myTurn ? "Your turn — fire!" : "Opponent's turn"}
        </span>
        {state.opponent?.is_ai && (
          <span className="text-sm opacity-70">
            AI difficulty:{" "}
            <span className="font-medium">{state.game.ai_difficulty}</span>
          </span>
        )}
      </div>
      {lastResult && (
        <div className="mb-4 text-sm p-3 rounded-lg bg-white/70 dark:bg-slate-900/70 border">
          {lastResult}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div>
          <h3 className="font-semibold mb-2 text-sm uppercase tracking-wider opacity-70">
            Your fleet
          </h3>
          <Grid
            renderCell={(row, col) => {
              const ship = myShipCells.get(`${row},${col}`);
              const hit = myHitCells.has(`${row},${col}`);
              const miss = theirMisses.has(`${row},${col}`);
              const c = ship ? SHIP_COLORS[ship.type] : null;
              return (
                <div
                  className={`w-full h-full text-sm flex items-center justify-center font-bold ${
                    hit
                      ? ship?.sunk
                        ? "bg-rose-900 text-white"
                        : "bg-rose-600 text-white"
                      : ship
                      ? c!.ship
                      : miss
                      ? "bg-zinc-300 dark:bg-slate-700"
                      : "bg-cyan-50 dark:bg-slate-900"
                  }`}
                >
                  {hit ? "✕" : miss ? "·" : ""}
                </div>
              );
            }}
          />
        </div>
        <div>
          <h3 className="font-semibold mb-2 text-sm uppercase tracking-wider opacity-70">
            Enemy waters
          </h3>
          <Grid
            renderCell={(row, col) => {
              const result = myShotsMap.get(`${row},${col}`);
              const cellLabel =
                result === "sunk"
                  ? "💀"
                  : result === "hit"
                  ? "✕"
                  : result === "miss"
                  ? "·"
                  : "";
              const bg =
                result === "hit"
                  ? "bg-rose-600 text-white"
                  : result === "sunk"
                  ? "bg-rose-900 text-white"
                  : result === "miss"
                  ? "bg-zinc-300 dark:bg-slate-700"
                  : myTurn && !firing
                  ? "bg-cyan-50 hover:bg-blue-300 dark:bg-slate-900 dark:hover:bg-blue-900 cursor-crosshair"
                  : "bg-cyan-50 dark:bg-slate-900 opacity-60";
              return (
                <button
                  onClick={() => onFire(row, col)}
                  disabled={!myTurn || firing || result !== undefined}
                  className={`w-full h-full text-sm font-bold ${bg}`}
                >
                  {cellLabel}
                </button>
              );
            }}
          />
          {state.opponent && state.opponent.sunk_ship_types.length > 0 && (
            <div className="mt-3 text-sm opacity-80">
              Sunk:{" "}
              {state.opponent.sunk_ship_types.map((t) => (
                <span
                  key={t}
                  className="inline-block px-2 py-0.5 mr-1 rounded text-white text-xs"
                  style={{ backgroundColor: undefined }}
                >
                  <span className={`px-2 py-0.5 rounded ${SHIP_COLORS[t].ship} text-white`}>
                    {t}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// 10x10 grid with row/col labels
// =====================================================================
const CELL = "2rem"; // 32px — fits iPhone SE (320px wide grid) and looks fine on desktop

function Grid({
  renderCell,
}: {
  renderCell: (row: number, col: number) => React.ReactNode;
}) {
  return (
    <div className="inline-block">
      <div className="flex">
        <div style={{ width: "1.5rem" }} />
        {COL_LABELS.map((l) => (
          <div
            key={l}
            className="text-center text-xs opacity-60 font-mono"
            style={{ width: CELL }}
          >
            {l}
          </div>
        ))}
      </div>
      <div className="border border-cyan-700/30 dark:border-cyan-300/20 rounded-md overflow-hidden flex">
        <div className="flex flex-col">
          {Array.from({ length: BOARD_SIZE }, (_, row) => (
            <div
              key={row}
              className="flex items-center justify-center text-xs opacity-60 font-mono"
              style={{ width: "1.5rem", height: CELL }}
            >
              {row + 1}
            </div>
          ))}
        </div>
        <div
          className="grid gap-px bg-cyan-700/20 dark:bg-cyan-300/10"
          style={{ gridTemplateColumns: `repeat(10, ${CELL})` }}
        >
          {Array.from({ length: BOARD_SIZE }, (_, row) =>
            Array.from({ length: BOARD_SIZE }, (_, col) => (
              <div
                key={`${row}-${col}`}
                style={{ width: CELL, height: CELL }}
              >
                {renderCell(row, col)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
