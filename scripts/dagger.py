# /// script
# requires-python = ">=3.10"
# dependencies = ["torch>=2.1", "numpy>=1.26", "onnx>=1.16", "onnxruntime>=1.17"]
# ///
"""
DAgger round: roll out the trained NN, query the analytical expert at the
states the NN actually visits, append to dataset, retrain. Closes the
distribution-shift gap inherent to plain imitation.

Workflow:
  1. Load `public/expert.onnx` (must exist — run `train_expert.py` first).
  2. Generate fresh self-play data the normal way (expert vs random env).
  3. Generate "DAgger" data: NN plays the env, expert labels each state.
  4. Train on the combined dataset.

Run:
  uv run scripts/dagger.py
"""

from __future__ import annotations

import random
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
import torch.nn.functional as F

# Reuse all the building blocks from the main training script
import sys
sys.path.insert(0, str(Path(__file__).parent))
from train_expert import (  # noqa: E402
    BOARD,
    ExpertNet,
    Ship,
    encode_observation,
    expert_target,
    random_ships,
    play_one_game,
)


def play_one_game_dagger(
    session: ort.InferenceSession,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """One game where the NN picks actions; expert labels each visited state."""
    ships: list[Ship] = random_ships()
    cell_to_ship: dict[tuple[int, int], Ship] = {}
    for s in ships:
        for cell in s.cells:
            cell_to_ship[cell] = s

    history: list[tuple[int, int, str, str | None]] = []
    sunk_ships: set[str] = set()
    examples: list[tuple[np.ndarray, np.ndarray]] = []

    while any(not s.sunk for s in ships) and len(history) < BOARD * BOARD:
        obs = encode_observation(history, sunk_ships)

        # Expert label at this state
        _, target = expert_target(history, sunk_ships)
        examples.append((obs, target))

        # NN picks the action
        x = obs[np.newaxis, ...]  # add batch dim
        logits = session.run(["policy_logits"], {"observation": x})[0][0]
        # Mask shot cells
        shot_mask = np.zeros(BOARD * BOARD, dtype=bool)
        for r, c, _, _ in history:
            shot_mask[r * BOARD + c] = True
        masked = np.where(shot_mask, -np.inf, logits)
        nn_idx = int(np.argmax(masked))
        r, c = divmod(nn_idx, BOARD)

        # Resolve in environment
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


def main(
    expert_games: int = 3000,
    dagger_games: int = 2000,
    epochs: int = 15,
    batch_size: int = 256,
    lr: float = 1e-3,
    model_path: str = "public/expert.onnx",
    out_path: str = "public/expert.onnx",
) -> None:
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Device: {device}")

    print(f"Loading existing model from {model_path}…")
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])

    print(f"Generating {expert_games} expert-rollout games…")
    t0 = time.time()
    examples: list[tuple[np.ndarray, np.ndarray]] = []
    for i in range(expert_games):
        examples.extend(play_one_game())
        if (i + 1) % 200 == 0:
            print(f"  {i + 1}/{expert_games} expert — {len(examples)} examples — {time.time() - t0:.1f}s")
    expert_count = len(examples)

    print(f"Generating {dagger_games} DAgger (NN-rollout, expert-labeled) games…")
    t1 = time.time()
    for i in range(dagger_games):
        examples.extend(play_one_game_dagger(session))
        if (i + 1) % 100 == 0:
            print(
                f"  {i + 1}/{dagger_games} dagger — {len(examples) - expert_count} new examples — "
                f"{time.time() - t1:.1f}s"
            )
    print(f"  total {len(examples)} examples ({expert_count} expert + {len(examples) - expert_count} dagger)")

    obs = np.stack([e[0] for e in examples])
    targets = np.stack([e[1] for e in examples])
    obs_t = torch.from_numpy(obs).to(device)
    target_t = torch.from_numpy(targets).to(device)

    model = ExpertNet().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    n = len(examples)
    print(f"Training on {n} combined examples")
    for ep in range(epochs):
        perm = torch.randperm(n, device=device)
        total = 0.0
        argmax_match = 0
        for i in range(0, n, batch_size):
            idx = perm[i : i + batch_size]
            x = obs_t[idx]
            y = target_t[idx]
            opt.zero_grad()
            logits = model(x)
            log_probs = F.log_softmax(logits, dim=1)
            loss = -(y * log_probs).sum(dim=1).mean()
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
            argmax_match += int((logits.argmax(dim=1) == y.argmax(dim=1)).sum().item())
        print(f"  epoch {ep + 1}: loss={total / n:.4f}  argmax-match={argmax_match / n:.3f}")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    model.cpu().eval()

    ckpt = out.with_suffix(".pt")
    torch.save(model.state_dict(), ckpt)
    print(f"Saved state_dict to {ckpt}")

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
    main()
