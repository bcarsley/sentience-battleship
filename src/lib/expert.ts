import { promises as fs } from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-web";
import { BOARD_SIZE, Cell, ShipType } from "./game-rules";
import { AIDifficulty, AIShotRecord, pickAIShot } from "./ai";

// ORT's WASM helpers are copied to public/onnxruntime-web/ at build time
// (scripts/copy-ort-assets.mjs). Server-side we point ORT at a local file:// URL
// so its dynamic-import of the helper .mjs works under Node's default ESM loader
// (which rejects https:// imports without --experimental-network-imports).
const ORT_DIR = path.join(process.cwd(), "public", "onnxruntime-web");
ort.env.wasm.wasmPaths = `file://${ORT_DIR}/`;
ort.env.wasm.numThreads = 1;

// Server-side ONNX inference for the Tier-4 "Expert" model.
// Lazy-loaded once per process; falls back to null if the model file is absent
// (in which case ai.ts falls back to the Tier-3 Bayesian player).

let _session: ort.InferenceSession | null = null;
let _attempted = false;

async function loadSession(): Promise<ort.InferenceSession | null> {
  if (_session) return _session;
  if (_attempted) return null;
  _attempted = true;
  try {
    const modelPath = path.join(process.cwd(), "public", "expert.onnx");
    const buf = await fs.readFile(modelPath);
    _session = await ort.InferenceSession.create(buf, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    console.log("[expert] model loaded");
    return _session;
  } catch (err) {
    console.warn("[expert] model unavailable:", (err as Error).message);
    return null;
  }
}

function encodeObservation(shots: AIShotRecord[]): Float32Array {
  // 3 channels: [miss-mask, active-hit-mask, sunk-cell-mask], 10x10
  // A hit is "active" until any later shot of the same ship_type goes 'sunk' —
  // at which point all hits on that ship migrate from active to sunk channel.
  const PLANE = BOARD_SIZE * BOARD_SIZE;
  const arr = new Float32Array(3 * PLANE);

  // Pass 1: collect sunk ship_types
  const sunkTypes = new Set<string>();
  for (const s of shots) {
    if (s.result === "sunk" && s.ship_type) sunkTypes.add(s.ship_type);
  }

  for (const s of shots) {
    const idx = s.row * BOARD_SIZE + s.col;
    if (s.result === "miss") {
      arr[0 * PLANE + idx] = 1.0;
    } else if (s.ship_type && sunkTypes.has(s.ship_type)) {
      arr[2 * PLANE + idx] = 1.0;
    } else {
      arr[1 * PLANE + idx] = 1.0;
    }
  }
  return arr;
}

export async function pickExpertCell(
  shots: AIShotRecord[],
  temperature: number = 0
): Promise<Cell | null> {
  const session = await loadSession();
  if (!session) return null;

  const taken = new Set(shots.map((s) => `${s.row},${s.col}`));
  const obs = encodeObservation(shots);
  const tensor = new ort.Tensor("float32", obs, [1, 3, BOARD_SIZE, BOARD_SIZE]);
  const out = await session.run({ observation: tensor });
  const logits = out.policy_logits.data as Float32Array;

  // Mask shot cells
  const masked = new Float32Array(BOARD_SIZE * BOARD_SIZE);
  for (let i = 0; i < masked.length; i++) {
    const r = Math.floor(i / BOARD_SIZE);
    const c = i % BOARD_SIZE;
    masked[i] = taken.has(`${r},${c}`) ? -Infinity : logits[i];
  }

  if (temperature <= 0) {
    // Argmax
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] > best) {
        best = masked[i];
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return null;
    return { row: Math.floor(bestIdx / BOARD_SIZE), col: bestIdx % BOARD_SIZE };
  }

  // Softmax with temperature, then sample
  const scaled = masked.map((v) => v / temperature);
  let maxV = -Infinity;
  for (const v of scaled) if (v > maxV) maxV = v;
  const exp = scaled.map((v) => Math.exp(v - maxV));
  let sum = 0;
  for (const v of exp) sum += v;
  const probs = exp.map((v) => v / sum);
  const u = Math.random();
  let cum = 0;
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i];
    if (u < cum) {
      return { row: Math.floor(i / BOARD_SIZE), col: i % BOARD_SIZE };
    }
  }
  return { row: 9, col: 9 };
}

// Wrapper that consolidates all four difficulty tiers, including the async
// Tier-4 model path. Falls back to Tier-3 (Bayesian) if the model isn't loaded.
export async function pickAIShotAsync(
  difficulty: AIDifficulty,
  shots: AIShotRecord[],
  remainingShipTypes: ShipType[]
): Promise<Cell> {
  if (difficulty === "expert") {
    const cell = await pickExpertCell(shots, 0);
    if (cell) return cell;
    // Model unavailable — fall back to analytical optimum
    return pickAIShot("hard", shots, remainingShipTypes);
  }
  return pickAIShot(difficulty, shots, remainingShipTypes);
}

