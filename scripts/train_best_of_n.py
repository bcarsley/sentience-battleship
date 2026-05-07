# /// script
# requires-python = ">=3.10"
# dependencies = ["torch>=2.1", "numpy>=1.26", "onnx>=1.16", "onnxruntime>=1.17"]
# ///
"""Train N expert models with different seeds, keep the best by self-evaluation.

Self-eval: each candidate plays 100 random-placement boards solo, mean-shots-to-finish.
Lower = better. Best model wins, others are discarded.

Run: uv run scripts/train_best_of_n.py [N]
"""

from __future__ import annotations

import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

sys.path.insert(0, str(Path(__file__).parent))
from train_expert import (  # noqa: E402
    BOARD,
    SHIP_NAMES,
    SHIP_SIZES,
    train,
    Ship,
    random_ships,
)


def evaluate_onnx(model_path: str, num_games: int = 100) -> tuple[float, float]:
    """Return (mean shots, std shots) playing solo with the ONNX policy."""
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    samples: list[int] = []
    for _ in range(num_games):
        ships: list[Ship] = random_ships()
        cell_to_ship: dict[tuple[int, int], Ship] = {}
        for s in ships:
            for cell in s.cells:
                cell_to_ship[cell] = s

        history: list[tuple[int, int, str, str | None]] = []
        sunk_ships: set[str] = set()
        shots = 0
        while any(not s.sunk for s in ships) and shots < BOARD * BOARD:
            obs = np.zeros((1, 3, BOARD, BOARD), dtype=np.float32)
            for r, c, res, ship in history:
                if res == "miss":
                    obs[0, 0, r, c] = 1.0
                elif ship in sunk_ships:
                    obs[0, 2, r, c] = 1.0
                else:
                    obs[0, 1, r, c] = 1.0
            logits = session.run(["policy_logits"], {"observation": obs})[0][0]
            shot_mask = np.zeros(BOARD * BOARD, dtype=bool)
            for r, c, _, _ in history:
                shot_mask[r * BOARD + c] = True
            masked = np.where(shot_mask, -np.inf, logits)
            idx = int(np.argmax(masked))
            r, c = divmod(idx, BOARD)
            if (r, c) in cell_to_ship:
                ship = cell_to_ship[(r, c)]
                ship.hits.add((r, c))
                if len(ship.hits) >= ship.size:
                    ship.sunk = True
                    sunk_ships.add(ship.name)
                    history.append((r, c, "sunk", ship.name))
                else:
                    history.append((r, c, "hit", ship.name))
            else:
                history.append((r, c, "miss", None))
            shots += 1
        samples.append(shots)
    arr = np.array(samples, dtype=np.float64)
    return float(arr.mean()), float(arr.std())


def main(n: int) -> None:
    out_final = Path("public/expert.onnx")
    candidates = []

    for i in range(n):
        seed = random.randint(0, 1_000_000)
        print(f"\n=== run {i + 1}/{n} (seed {seed}) ===")
        torch.manual_seed(seed)
        np.random.seed(seed)
        random.seed(seed)

        candidate_path = Path(f"models/candidate_{i}.onnx")
        candidate_path.parent.mkdir(parents=True, exist_ok=True)
        train(out_path=str(candidate_path))

        t0 = time.time()
        mean, std = evaluate_onnx(str(candidate_path), num_games=100)
        print(f"  eval: mean={mean:.1f} std={std:.1f} ({time.time() - t0:.1f}s)")
        candidates.append((mean, candidate_path, seed))

    candidates.sort(key=lambda x: x[0])
    print("\n=== final standings ===")
    for mean, path, seed in candidates:
        print(f"  {mean:.1f}  {path.name}  (seed={seed})")

    best_mean, best_path, best_seed = candidates[0]
    out_final.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(best_path, out_final)
    print(f"\nBest model: {best_path.name} (mean={best_mean:.1f}, seed={best_seed})")
    print(f"Copied to {out_final}")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    main(n)
