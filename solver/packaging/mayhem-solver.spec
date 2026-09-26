# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the `mayhem-solver` desktop sidecar.

Build from the solver/ directory:

    uv run pyinstaller packaging/mayhem-solver.spec --noconfirm \
        --distpath build/pyinstaller/dist --workpath build/pyinstaller/work

(or just run scripts/build-sidecar.sh from the repo root, which also copies the result into
app/src-tauri/binaries/ with the Rust target-triple suffix Tauri expects).

Produces a single-file executable (Tauri `bundle.externalBin` needs one file per platform).
Set MAYHEM_PYI_ONEDIR=1 to get an unpacked onedir build instead, which is handy for
inspecting exactly what got collected.

CasADi loads its solver plugins (libcasadi_nlpsol_ipopt, libcasadi_linsol_mumps, ...)
with dlopen() at runtime from its own package directory, so PyInstaller's import analysis
never sees them. collect_all('casadi') copies the whole package, including every plugin and
the IPOPT / MUMPS / METIS / gfortran runtime libraries, preserving the casadi/ layout.
"""

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ONEDIR = os.environ.get("MAYHEM_PYI_ONEDIR") == "1"

SOLVER_DIR = Path(SPECPATH).resolve().parent  # noqa: F821 - SPECPATH is injected by PyInstaller
PKG_DIR = SOLVER_DIR / "src" / "mayhem_solver"

datas = [(str(p), "mayhem_solver/fields") for p in sorted((PKG_DIR / "fields").glob("*.json"))]
binaries = []
hiddenimports = []

# --- casadi: everything (Python module + dlopen()ed plugins + bundled third-party libs)
c_datas, c_bins, c_hidden = collect_all("casadi")
# Drop build-time only files (static archives, libtool files, headers, cmake/pkgconfig).
_SKIP_SUFFIX = (".a", ".la", ".h", ".hpp", ".hh", ".cmake", ".pc", ".pyi")
_SKIP_PARTS = ("include", "cmake", "pkgconfig", "__pycache__")


def _keep(entry):
    src, dest = entry[0], entry[1]
    if src.endswith(_SKIP_SUFFIX):
        return False
    return not any(part in _SKIP_PARTS for part in Path(src).parts[-4:])


datas += [e for e in c_datas if _keep(e)]
binaries += [e for e in c_bins if _keep(e)]
hiddenimports += c_hidden

# --- pure-python deps with lazy / dynamic imports
for pkg in ("mayhem_solver", "websockets", "networkx", "shapely", "pydantic"):
    hiddenimports += collect_submodules(pkg, filter=lambda name: ".tests" not in name and ".testing" not in name)
hiddenimports += ["pydantic_core", "annotated_types", "typing_inspection"]

a = Analysis(  # noqa: F821
    [str(SOLVER_DIR / "packaging" / "entry.py")],
    pathex=[str(SOLVER_DIR / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter", "matplotlib", "IPython", "pytest", "_pytest", "setuptools", "pip",
        "scipy", "pandas", "PIL", "PyInstaller",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)  # noqa: F821

if ONEDIR:
    exe = EXE(  # noqa: F821
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="mayhem-solver",
        debug=False,
        strip=False,
        upx=False,
        console=True,
    )
    coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="mayhem-solver")  # noqa: F821
else:
    exe = EXE(  # noqa: F821
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="mayhem-solver",
        debug=False,
        strip=False,
        upx=False,
        runtime_tmpdir=None,
        console=True,
    )
