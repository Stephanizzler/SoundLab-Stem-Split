"""Builds a small random-weight HTDemucs bag and the output Demucs itself gives
for a test signal, so `npm run test:model` can check the app's TypeScript
pipeline (spectrogram, segments, shifts, bag weights) against Demucs.

  python tools/make_reference.py tests-model/fixtures
The weights are random: this checks the maths, not separation quality.
"""
import json
import os
import random
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
import export_demucs_onnx as E  # noqa: E402
from demucs import apply as A  # noqa: E402
from demucs.apply import BagOfModels, apply_model  # noqa: E402
from demucs.htdemucs import HTDemucs  # noqa: E402

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
torch.manual_seed(1)
sources = ["drums", "bass", "other", "vocals"]
models = [HTDemucs(sources=sources, channels=8, t_layers=1, segment=2).eval() for _ in range(2)]
weights = [[1.0, 0.0, 1.0, 0.5], [0.0, 1.0, 1.0, 0.5]]
manifest = E.write_bundle(models, weights, "test-random", "Test model (random weights)", out, "Test only")
torch.backends.mha.set_fastpath_enabled(True)

sr = 44100
n = int(sr * 5.3)  # several segments plus a short last one
t = np.arange(n) / sr
rng = np.random.default_rng(0)
left = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.05 * rng.standard_normal(n)
right = 0.2 * np.sin(2 * np.pi * 330 * t + 1) + 0.05 * rng.standard_normal(n)
wav = torch.tensor(np.stack([left, right]), dtype=torch.float32)

SHIFTS, OVERLAP = 2, 0.25
max_shift = int(0.5 * sr)
offsets = [int(max_shift * (k + 0.5) / SHIFTS) for k in range(SHIFTS)]  # = shiftOffsets() in separate.ts
queue = []
A.random.randint = lambda a, b: queue.pop(0)

bag = BagOfModels(models, weights)
ref = wav.mean(0)
mean, std = ref.mean(), ref.std() + 1e-8
queue[:] = offsets * len(models)
with torch.no_grad():
    est = apply_model(bag, ((wav - mean) / std)[None], shifts=SHIFTS, split=True, overlap=OVERLAP)
est = (est * std + mean)[0]

wav.numpy().astype("<f4").tofile(os.path.join(out, "input.f32"))
est.numpy().astype("<f4").tofile(os.path.join(out, "expected.f32"))
with open(os.path.join(out, "case.json"), "w") as f:
    json.dump({"manifest": "test-random.json", "length": n, "shifts": SHIFTS, "overlap": OVERLAP}, f)
print("wrote", out, est.shape)
