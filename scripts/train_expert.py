# /// script
# requires-python = ">=3.10"
# dependencies = ["torch>=2.1", "numpy>=1.26", "onnx>=1.16"]
# ///
"""
Imitation-learn a small CNN to play Battleship by mimicking the analytical
Bayesian probability-density player. Exports to ONNX for in-process inference
via onnxruntime-node.

Run locally:
    uv run scripts/train_expert.py

Improvements over v1:
  * Per-ship hit tracking — fixes the active-hit attribution bug where
    sinking ship A would erase active hits on ship B.
  * 3-channel observation: (miss, active-hit, sunk-cell). The sunk channel
    gives the NN visibility into the same posterior the analytical expert uses.
  * Soft-target KL loss — train against the full normalized density distribution
    rather than one-hot of the (often arbitrary) argmax tie-break. Lets the NN
    learn the posterior, not the noise.
"""

from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


BOARD = 10
SHIP_NAMES = ["carrier", "battleship", "cruiser", "submarine", "destroyer"]
SHIP_SIZES = {"carrier": 5, "battleship": 4, "cruiser": 3, "submarine": 3, "destroyer": 2}


def set_all_seeds(seed: int) -> None:
    """Seed every RNG that affects training. Determinism caveat: MPS reductions
    have non-deterministic op ordering, so different runs may differ by ε on
    intermediate values. CPU runs would be fully reproducible at significant speed cost."""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.backends.mps.is_available():
        torch.mps.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


@dataclass
class Ship:
    name: str
    size: int
    cells: set[tuple[int, int]]
    hits: set[tuple[int, int]] = field(default_factory=set)
    sunk: bool = False


def random_ships() -> list[Ship]:
    for _ in range(50):
        ships: list[Ship] = []
        occupied: set[tuple[int, int]] = set()
        ok = True
        for name in SHIP_NAMES:
            size = SHIP_SIZES[name]
            placed = False
            for _ in range(500):
                o = random.choice(["h", "v"])
                r = random.randint(0, BOARD - 1)
                c = random.randint(0, BOARD - 1)
                cells = [
                    (r, c + i) if o == "h" else (r + i, c) for i in range(size)
                ]
                if any(not (0 <= rr < BOARD and 0 <= cc < BOARD) for rr, cc in cells):
                    continue
                if any(cell in occupied for cell in cells):
                    continue
                ships.append(Ship(name=name, size=size, cells=set(cells)))
                occupied.update(cells)
                placed = True
                break
            if not placed:
                ok = False
                break
        if ok:
            return ships
    raise RuntimeError("placement failed")


def bayesian_density(
    forbidden: set[tuple[int, int]],
    remaining_sizes: list[int],
) -> np.ndarray:
    """For each cell, count placements consistent with `forbidden` (= misses ∪ sunk cells)
    across remaining unsunk ships. A remaining ship cannot occupy any forbidden cell —
    misses because no ship is there, sunk cells because they're already a (dead) ship."""
    counts = np.zeros((BOARD, BOARD), dtype=np.float64)
    for size in remaining_sizes:
        for r in range(BOARD):
            for c in range(BOARD - size + 1):
                cells = [(r, c + i) for i in range(size)]
                if any(cell in forbidden for cell in cells):
                    continue
                for rr, cc in cells:
                    counts[rr, cc] += 1
        for r in range(BOARD - size + 1):
            for c in range(BOARD):
                cells = [(r + i, c) for i in range(size)]
                if any(cell in forbidden for cell in cells):
                    continue
                for rr, cc in cells:
                    counts[rr, cc] += 1
    return counts


def expert_target(
    history: list[tuple[int, int, str, str | None]],
    sunk_ships: set[str],
) -> tuple[tuple[int, int], np.ndarray]:
    """
    Pick the next cell using fixed hunt-target → Bayesian density.
    Returns (argmax_cell, soft_target_distribution_over_100_cells).
    """
    misses = {(r, c) for (r, c, res, _) in history if res == "miss"}
    shot = {(r, c) for (r, c, _, _) in history}

    # Per-ship active hits
    by_ship: dict[str, list[tuple[int, int]]] = {}
    for r, c, res, ship in history:
        if res == "miss" or ship is None:
            continue
        if res == "sunk":
            by_ship.pop(ship, None)
        else:  # hit
            by_ship.setdefault(ship, []).append((r, c))

    # Pursue most-recently-hit unsunk ship
    target_ship = None
    for r, c, res, ship in reversed(history):
        if res == "hit" and ship in by_ship:
            target_ship = ship
            break
    active = by_ship.get(target_ship, []) if target_ship else []

    if active:
        if len(active) == 1:
            (r, c) = active[0]
            cands = [(r + dr, c + dc) for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]]
        else:
            sh = sorted(active)
            if all(rr == sh[0][0] for rr, _ in sh):
                row = sh[0][0]
                cands = [(row, sh[0][1] - 1), (row, sh[-1][1] + 1)]
            elif all(cc == sh[0][1] for _, cc in sh):
                col = sh[0][1]
                cands = [(sh[0][0] - 1, col), (sh[-1][0] + 1, col)]
            else:
                cands = []
        cands = sorted(  # deterministic ordering — tie-break top-down, left-right
            (rr, cc)
            for rr, cc in cands
            if 0 <= rr < BOARD and 0 <= cc < BOARD and (rr, cc) not in shot
        )
        if cands:
            # Soft target spreads probability evenly across all live candidates;
            # argmax picks the first (deterministic given seeded inputs) for play.
            chosen = cands[0]
            target = np.zeros(BOARD * BOARD, dtype=np.float32)
            for cr, cc in cands:
                target[cr * BOARD + cc] = 1.0 / len(cands)
            return chosen, target

    # Hunt: Bayesian density across sunk-aware remaining ships, with sunk cells excluded.
    # Sunk cells are part of dead ships; a remaining ship cannot pass through them.
    sunk_cells = {(r, c) for (r, c, _, ship) in history if ship in sunk_ships}
    forbidden = misses | sunk_cells
    remaining_sizes = [SHIP_SIZES[n] for n in SHIP_NAMES if n not in sunk_ships]
    counts = bayesian_density(forbidden, remaining_sizes)
    for r, c in shot:
        counts[r, c] = 0.0  # mask shot cells (defense-in-depth — they're already in forbidden)
    flat = counts.flatten().astype(np.float32)
    s = float(flat.sum())
    if s > 0:
        target = flat / s
    else:
        # Pathological: no consistent placement (shouldn't happen mid-game)
        free = np.array([
            1.0 if (r, c) not in shot else 0.0
            for r in range(BOARD)
            for c in range(BOARD)
        ], dtype=np.float32)
        target = free / max(free.sum(), 1.0)
    argmax_idx = int(target.argmax())
    return divmod(argmax_idx, BOARD), target


def encode_observation(
    history: list[tuple[int, int, str, str | None]],
    sunk_ships: set[str],
) -> np.ndarray:
    """3 channels: (miss, active-hit, sunk-cell)."""
    obs = np.zeros((3, BOARD, BOARD), dtype=np.float32)
    for r, c, res, ship in history:
        if res == "miss":
            obs[0, r, c] = 1.0
        elif ship in sunk_ships:
            obs[2, r, c] = 1.0
        else:
            obs[1, r, c] = 1.0
    return obs


def play_one_game() -> list[tuple[np.ndarray, np.ndarray]]:
    """Self-play; returns list of (3xHxW observation, 100-dim soft target)."""
    ships = random_ships()
    cell_to_ship: dict[tuple[int, int], Ship] = {}
    for s in ships:
        for cell in s.cells:
            cell_to_ship[cell] = s

    history: list[tuple[int, int, str, str | None]] = []
    sunk_ships: set[str] = set()
    examples: list[tuple[np.ndarray, np.ndarray]] = []

    while any(not s.sunk for s in ships) and len(history) < BOARD * BOARD:
        obs = encode_observation(history, sunk_ships)
        (r, c), target = expert_target(history, sunk_ships)
        examples.append((obs, target))

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

    return examples


class ExpertNet(nn.Module):
    """3-channel CNN. ~700k params — capacity-tuned via tournament eval; bigger
    versions (1.5M+, residual blocks) overfit the soft KL targets and regress
    on actual play despite better argmax-match metrics."""

    def __init__(self) -> None:
        super().__init__()
        self.conv1 = nn.Conv2d(3, 32, 3, padding=1)
        self.conv2 = nn.Conv2d(32, 64, 3, padding=1)
        self.conv3 = nn.Conv2d(64, 64, 3, padding=1)
        self.fc = nn.Linear(64 * BOARD * BOARD, BOARD * BOARD)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.conv1(x))
        x = F.relu(self.conv2(x))
        x = F.relu(self.conv3(x))
        x = x.flatten(1)
        return self.fc(x)


def train(
    num_games: int = 5000,
    epochs: int = 15,
    batch_size: int = 256,
    lr: float = 1e-3,
    out_path: str = "public/expert.onnx",
    ckpt_dir: str = "models",
    seed: int | None = None,
) -> None:
    if seed is None:
        seed = int(os.environ.get("BS_SEED", "42"))
    set_all_seeds(seed)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}  seed={seed}")

    print(f"Generating {num_games} self-play games (3-channel obs, soft KL targets)…")
    t0 = time.time()
    examples: list[tuple[np.ndarray, np.ndarray]] = []
    for i in range(num_games):
        examples.extend(play_one_game())
        if (i + 1) % 500 == 0:
            print(
                f"  {i + 1}/{num_games} games — {len(examples)} examples — "
                f"{time.time() - t0:.1f}s"
            )

    obs = np.stack([e[0] for e in examples])
    targets = np.stack([e[1] for e in examples])
    obs_t = torch.from_numpy(obs).to(device)
    target_t = torch.from_numpy(targets).to(device)

    model = ExpertNet().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    n = len(examples)
    print(
        f"Training {sum(p.numel() for p in model.parameters())} params "
        f"on {n} examples (KL with soft targets)"
    )
    for ep in range(epochs):
        perm = torch.randperm(n, device=device)
        total = 0.0
        argmax_match = 0
        for i in range(0, n, batch_size):
            idx = perm[i : i + batch_size]
            x = obs_t[idx]
            y_soft = target_t[idx]
            opt.zero_grad()
            logits = model(x)
            log_probs = F.log_softmax(logits, dim=1)
            loss = -(y_soft * log_probs).sum(dim=1).mean()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
            argmax_match += int(
                (logits.argmax(dim=1) == y_soft.argmax(dim=1)).sum().item()
            )
        print(
            f"  epoch {ep + 1}: loss={total / n:.4f}  argmax-match={argmax_match / n:.3f}"
        )

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    model.cpu().eval()

    ckpt_path = Path(ckpt_dir) / (out.stem + ".pt")
    ckpt_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), ckpt_path)
    print(f"Saved state_dict to {ckpt_path}")

    print(f"Exporting to {out}")
    dummy = torch.zeros(1, 3, BOARD, BOARD)
    export_kwargs = dict(
        input_names=["observation"],
        output_names=["policy_logits"],
        opset_version=17,
        dynamic_axes={
            "observation": {0: "batch"},
            "policy_logits": {0: "batch"},
        },
    )
    try:
        torch.onnx.export(model, dummy, str(out), dynamo=False, **export_kwargs)
    except TypeError:
        torch.onnx.export(model, dummy, str(out), **export_kwargs)
    print(f"Wrote {out}  ({out.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    train()
