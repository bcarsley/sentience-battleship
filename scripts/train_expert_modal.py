# /// script
# requires-python = ">=3.10"
# dependencies = ["modal>=0.65"]
# ///
"""
Modal alternative for the expert-network trainer. Demonstrates how this would
scale if the model were too large to train locally — a 5-line wrapper around
the same train() function in `train_expert.py`.

NOT required for the take-home — the local script is sufficient for a 50k-param
model. Included to show the path for when the model grows (e.g., transformer
over the move history, or self-play RL with replay buffer + many parallel envs).

Usage:
    modal run scripts/train_expert_modal.py
"""

import modal

app = modal.App("sentience-battleship-expert")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch>=2.1", "numpy>=1.26", "onnx>=1.16")
    .add_local_file(__file__.replace("_modal.py", ".py"), "/app/train_expert.py")
)


@app.function(image=image, gpu="A10G", timeout=1800)
def train_remote(num_games: int = 20000, epochs: int = 10) -> bytes:
    import sys
    sys.path.insert(0, "/app")
    from train_expert import train
    train(num_games=num_games, epochs=epochs, out_path="/tmp/expert.onnx")
    with open("/tmp/expert.onnx", "rb") as f:
        return f.read()


@app.local_entrypoint()
def main(num_games: int = 20000, epochs: int = 10) -> None:
    onnx_bytes = train_remote.remote(num_games=num_games, epochs=epochs)
    with open("public/expert.onnx", "wb") as f:
        f.write(onnx_bytes)
    print(f"Wrote public/expert.onnx ({len(onnx_bytes) / 1024:.1f} KB)")
