from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

from .errors import MeshError

STEP_SUFFIXES = {".stp", ".step"}
DEFAULT_LINEAR_TOLERANCE_MM = 0.05
DEFAULT_ANGULAR_TOLERANCE = 0.12


def is_step_path(path: str | Path) -> bool:
    return Path(path).suffix.lower() in STEP_SUFFIXES


def step_to_stl_path(
    path: str | Path,
    output_path: str | Path | None = None,
    *,
    linear_tolerance_mm: float = DEFAULT_LINEAR_TOLERANCE_MM,
    angular_tolerance: float = DEFAULT_ANGULAR_TOLERANCE,
) -> Path:
    source = Path(path)
    if not source.exists():
        raise MeshError(f"STEP file does not exist: {source}")
    if not is_step_path(source):
        raise MeshError(f"expected a .stp or .step file, got {source.suffix or '<none>'}")

    output = Path(output_path) if output_path else _cached_stl_path(source, linear_tolerance_mm, angular_tolerance)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and output.stat().st_mtime_ns >= source.stat().st_mtime_ns:
        return output

    try:
        from build123d import export_stl, import_step
    except Exception as exc:
        raise MeshError(
            "STEP/STP import requires OpenCascade/build123d. "
            "Set RESIN_SLICER_STEP_PYTHON to a Python runtime with build123d installed."
        ) from exc

    try:
        shape = import_step(str(source))
        ok = export_stl(
            shape,
            str(output),
            tolerance=max(0.001, float(linear_tolerance_mm)),
            angular_tolerance=max(0.001, float(angular_tolerance)),
            ascii_format=False,
        )
    except Exception as exc:
        raise MeshError(f"could not tessellate STEP file {source.name}: {exc}") from exc

    if not ok or not output.exists():
        raise MeshError(f"could not tessellate STEP file {source.name}")
    return output


def _cached_stl_path(source: Path, linear_tolerance_mm: float, angular_tolerance: float) -> Path:
    stat = source.stat()
    key = "|".join(
        [
            str(source.resolve()).lower(),
            str(stat.st_size),
            str(stat.st_mtime_ns),
            f"{linear_tolerance_mm:.6f}",
            f"{angular_tolerance:.6f}",
        ]
    )
    digest = hashlib.sha256(key.encode("utf-8", errors="ignore")).hexdigest()[:16]
    safe_stem = "".join(char if char.isalnum() or char in "._-" else "-" for char in source.stem).strip("-")
    safe_stem = safe_stem or "step-model"
    return Path(tempfile.gettempdir()) / "resin-slicer-step-cache" / f"{safe_stem}-{digest}.stl"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tessellate STEP/STP files for Resin Slicer")
    parser.add_argument("input", help="input .stp or .step file")
    parser.add_argument("--output", help="optional output STL path")
    parser.add_argument("--linear-tolerance", type=float, default=DEFAULT_LINEAR_TOLERANCE_MM)
    parser.add_argument("--angular-tolerance", type=float, default=DEFAULT_ANGULAR_TOLERANCE)
    args = parser.parse_args(argv)

    output = step_to_stl_path(
        args.input,
        args.output,
        linear_tolerance_mm=args.linear_tolerance,
        angular_tolerance=args.angular_tolerance,
    )
    print(json.dumps({"outputPath": str(output)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
