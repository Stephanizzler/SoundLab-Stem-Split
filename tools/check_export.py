"""Checks an exported model against Demucs: runs the real network in PyTorch and
the exported ONNX (plus Demucs' own inverse STFT) on the same random segment,
and fails if they differ. Used by the deploy workflow before publishing.
  python tools/check_export.py htdemucs public/models
"""
import json
import os
import sys

import numpy as np
import onnxruntime as ort
import torch
from demucs.apply import BagOfModels
from demucs.pretrained import get_model

name, out_dir = sys.argv[1], sys.argv[2]
manifest = json.load(open(os.path.join(out_dir, f"{name}.json")))
bag = get_model(name)
models = list(bag.models) if isinstance(bag, BagOfModels) else [bag]
torch.manual_seed(0)
for model, f in zip(models, manifest["files"]):
    model.eval()
    data = b"".join(open(os.path.join(out_dir, p["url"]), "rb").read() for p in f.get("parts", [f]))
    assert len(data) == f["bytes"], "size does not match the manifest"
    session = ort.InferenceSession(data)
    T = manifest["segmentSamples"]
    mix = 0.1 * torch.randn(1, 2, T)
    with torch.no_grad():
        ref = model(mix)
        z = model._spec(mix)
        B, C, Fr, F = z.shape
        spec = torch.view_as_real(z).permute(0, 1, 4, 2, 3).reshape(B, C * 2, Fr, F)
        time, zout = session.run(None, {"mix": mix.numpy(), "spec": spec.numpy()})
        zt = torch.from_numpy(zout)
        S = zt.shape[1]
        zc = torch.view_as_complex(zt.view(1, S, -1, 2, Fr, F).permute(0, 1, 2, 4, 5, 3).contiguous())
        est = torch.from_numpy(time) + model._ispec(zc, T)
    err = (est - ref).abs().max().item() / max(1e-6, ref.abs().max().item())
    print(f"{f['url']}: relative difference {err:.2e}")
    if not np.isfinite(err) or err > 1e-3:
        sys.exit(f"{f['url']} does not match Demucs")
print("ok: the export matches Demucs")
