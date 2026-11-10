"""Export Demucs v4 (Hybrid Transformer Demucs) to ONNX for SoundLab Stem Split.

The STFT and inverse STFT stay outside the ONNX graph (they use complex numbers,
which ONNX Runtime Web does not run), and the app does them in TypeScript
(src/engine/demucs.ts), matching demucs/htdemucs.py exactly.

ONNX contract, for one segment of `segmentSamples` stereo samples at 44.1 kHz:
  inputs   mix  float32 [1, 2, T]               the (normalised) audio segment
           spec float32 [1, 4, 2048, F]         HTDemucs._spec(mix) as real/imag channels
  outputs  time float32 [1, S, 2, T]            the time-branch estimate of each source
           zout float32 [1, S, 4, 2048, F]      the frequency-branch spectrogram of each source
  where F = ceil(T / 1024); the source estimate is time + _ispec(zout).

Usage (on a machine that can download the Demucs weights):
  pip install torch demucs onnx onnxscript
  python tools/export_demucs_onnx.py htdemucs public/models
  python tools/export_demucs_onnx.py htdemucs_6s public/models
  python tools/export_demucs_onnx.py htdemucs_ft public/models
"""
import argparse
import copy
import hashlib
import json
import math
import os

import torch
from torch import nn

NAMES = {
    "htdemucs": "Demucs v4 · 4 stems",
    "htdemucs_6s": "Demucs v4 · 6 stems (adds guitar and piano)",
    "htdemucs_ft": "Demucs v4 fine-tuned · 4 stems (best, 4× slower)",
}


class SplitHTDemucs(nn.Module):
    """HTDemucs with the STFT/iSTFT taken out, so the rest exports to ONNX."""

    def __init__(self, model):
        super().__init__()
        model = copy.deepcopy(model)  # the patches below must not touch the caller's model
        self.model = model
        self.captured = None
        model._spec = lambda x: None
        model._magnitude = lambda z: self._spec_input
        model._mask = lambda z, m: m  # keep complex-as-channels: [B, S, C*2, Fr, T]
        model._ispec = self._capture

    def _capture(self, z, length=None, scale=0):
        self.captured = z
        return z.new_zeros((z.shape[0], z.shape[1], z.shape[2] // 2, length))

    def forward(self, mix, spec):
        self._spec_input = spec
        time = self.model(mix)
        return time, self.captured


def segment_samples(model):
    return int(model.segment * model.samplerate)


def export_one(model, path):
    model.eval()
    # The fused attention kernel has no ONNX form; the plain path is the same maths.
    torch.backends.mha.set_fastpath_enabled(False)
    T = segment_samples(model)
    F = math.ceil(T / model.hop_length)
    mix = torch.randn(1, model.audio_channels, T)
    spec = torch.randn(1, model.audio_channels * 2, model.nfft // 2, F)
    with torch.no_grad():
        torch.onnx.export(
            SplitHTDemucs(model), (mix, spec), path,
            input_names=["mix", "spec"], output_names=["time", "zout"],
            opset_version=17, dynamo=False, do_constant_folding=True,
        )


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_bundle(bag_models, weights, model_id, name, out_dir, licence):
    """Exports every model of a bag and writes the manifest the app reads."""
    os.makedirs(out_dir, exist_ok=True)
    first = bag_models[0]
    files = []
    for i, m in enumerate(bag_models):
        file = f"{model_id}.{i}.onnx" if len(bag_models) > 1 else f"{model_id}.onnx"
        export_one(m, os.path.join(out_dir, file))
        files.append({"url": file, "bytes": os.path.getsize(os.path.join(out_dir, file)), "sha256": sha256(os.path.join(out_dir, file))})
    manifest = {
        "id": model_id,
        "name": name,
        "family": "htdemucs",
        "licence": licence,
        "sampleRate": first.samplerate,
        "channels": first.audio_channels,
        "segmentSamples": segment_samples(first),
        "nfft": first.nfft,
        "hop": first.hop_length,
        "sources": list(first.sources),
        "files": files,
        "weights": weights,
    }
    with open(os.path.join(out_dir, f"{model_id}.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    # index.json lists the models the app offers, in order.
    index_path = os.path.join(out_dir, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else []
    if f"{model_id}.json" not in index:
        index.append(f"{model_id}.json")
    with open(index_path, "w") as f:
        json.dump(index, f, indent=1)
    return manifest


def main():
    from demucs.apply import BagOfModels
    from demucs.pretrained import get_model

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("model", choices=sorted(NAMES))
    p.add_argument("out_dir")
    a = p.parse_args()
    model = get_model(a.model)
    models = list(model.models) if isinstance(model, BagOfModels) else [model]
    weights = [list(map(float, w)) for w in model.weights] if isinstance(model, BagOfModels) else [[1.0] * len(model.sources)]
    m = write_bundle(models, weights, a.model, NAMES[a.model], a.out_dir,
                     "Code: MIT (facebookresearch/demucs). Weights: see README, Model licences.")
    print(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
