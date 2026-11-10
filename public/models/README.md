# Models

Exported models go here for local use (they are not committed: each is 80–330 MB).

```sh
pip install torch demucs onnx onnxscript
python tools/export_demucs_onnx.py htdemucs public/models
```

This writes `htdemucs.onnx`, `htdemucs.json` (its description and checksum) and adds it to `index.json`, the list the app reads. In production, host these files anywhere (for example a CDN or a GitHub release) and build with `VITE_MODEL_BASE=https://…/models/`.
