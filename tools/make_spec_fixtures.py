"""Writes tests/fixtures/spec-*.f32: HTDemucs._spec and _ispec computed by
Demucs, which tests/demucs-spec.test.mjs compares the TypeScript against.
  python tools/make_spec_fixtures.py tests/fixtures
"""
import os
import sys

import numpy as np
import torch
from demucs.htdemucs import HTDemucs

out = sys.argv[1]
m = HTDemucs(sources=["a"], channels=8, t_layers=1, segment=2)
torch.manual_seed(3)
x = torch.randn(1, 1, 5000)
z = m._spec(x)[0, 0]
zz = torch.randn(1, 1, 2048, 5, dtype=torch.complex64)
y = m._ispec(zz, 5000)[0, 0]
w = lambda name, a: np.asarray(a, dtype="<f4").tofile(os.path.join(out, name))
w("spec-x.f32", x.numpy())
w("spec-z.f32", np.stack([z.real.numpy(), z.imag.numpy()]))
w("ispec-z.f32", np.stack([zz[0, 0].real.numpy(), zz[0, 0].imag.numpy()]))
w("ispec-y.f32", y.numpy())
