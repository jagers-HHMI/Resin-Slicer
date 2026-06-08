from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import tempfile
from pathlib import Path

from .errors import MeshError
from .mesh import Mesh

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

    mesh = step_to_mesh(
        source,
        linear_tolerance_mm=linear_tolerance_mm,
        angular_tolerance=angular_tolerance,
    )
    _write_binary_stl(output, mesh)
    return output


def step_to_mesh(
    path: str | Path,
    *,
    linear_tolerance_mm: float = DEFAULT_LINEAR_TOLERANCE_MM,
    angular_tolerance: float = DEFAULT_ANGULAR_TOLERANCE,
) -> Mesh:
    source = Path(path)
    if not source.exists():
        raise MeshError(f"STEP file does not exist: {source}")
    if not is_step_path(source):
        raise MeshError(f"expected a .stp or .step file, got {source.suffix or '<none>'}")

    shape = read_step_shape(source)
    return shape_to_mesh(
        shape,
        linear_tolerance_mm=linear_tolerance_mm,
        angular_tolerance=angular_tolerance,
    )


def read_step_shape(path: str | Path):
    source = Path(path)
    try:
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.STEPControl import STEPControl_Reader
    except Exception as exc:
        raise MeshError(
            "STEP/STP import requires OpenCascade/build123d. "
            "Set RESIN_SLICER_STEP_PYTHON to a Python runtime with build123d installed."
        ) from exc

    try:
        reader = STEPControl_Reader()
        status = reader.ReadFile(str(source))
        if status != IFSelect_RetDone:
            raise MeshError(f"OpenCascade could not read STEP file {source.name}")
        transferred = reader.TransferRoots()
        if transferred <= 0:
            raise MeshError(f"STEP file {source.name} did not contain transferable CAD roots")
        shape = reader.OneShape()
        if shape.IsNull():
            raise MeshError(f"STEP file {source.name} did not contain usable shape geometry")
        return _healed_shape(shape)
    except Exception as exc:
        if isinstance(exc, MeshError):
            raise
        raise MeshError(f"could not read STEP file {source.name}: {exc}") from exc


def shape_to_mesh(
    shape,
    *,
    linear_tolerance_mm: float = DEFAULT_LINEAR_TOLERANCE_MM,
    angular_tolerance: float = DEFAULT_ANGULAR_TOLERANCE,
) -> Mesh:
    try:
        from OCP.BRep import BRep_Tool
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopLoc import TopLoc_Location
        from OCP.TopoDS import TopoDS
    except Exception as exc:
        raise MeshError(
            "STEP/STP tessellation requires OpenCascade/build123d. "
            "Set RESIN_SLICER_STEP_PYTHON to a Python runtime with build123d installed."
        ) from exc

    linear = max(0.001, float(linear_tolerance_mm))
    angular = max(0.001, float(angular_tolerance))
    mesher = BRepMesh_IncrementalMesh(shape, linear, False, angular, True)
    mesher.Perform()
    if not mesher.IsDone():
        raise MeshError("OpenCascade tessellation did not complete")

    triangles = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is not None:
            transform = location.Transformation()
            reversed_face = face.Orientation() == TopAbs_REVERSED
            for index in range(1, triangulation.NbTriangles() + 1):
                triangle = triangulation.Triangle(index)
                node_indices = [triangle.Value(1), triangle.Value(2), triangle.Value(3)]
                if reversed_face:
                    node_indices[1], node_indices[2] = node_indices[2], node_indices[1]
                points = []
                for node_index in node_indices:
                    point = triangulation.Node(node_index).Transformed(transform)
                    points.append((point.X(), point.Y(), point.Z()))
                if _triangle_area2(points[0], points[1], points[2]) > 1e-12:
                    triangles.append((points[0], points[1], points[2]))
        explorer.Next()

    if not triangles:
        raise MeshError("STEP tessellation produced no non-degenerate triangles")
    return Mesh(tuple(triangles))


def _healed_shape(shape):
    try:
        from OCP.ShapeFix import ShapeFix_Shape

        fixer = ShapeFix_Shape(shape)
        fixer.Perform()
        fixed = fixer.Shape()
        return fixed if fixed is not None and not fixed.IsNull() else shape
    except Exception:
        return shape


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


def _write_binary_stl(path: Path, mesh: Mesh) -> None:
    header = b"Resin Slicer OpenCascade tessellation".ljust(80, b"\0")
    with path.open("wb") as stream:
        stream.write(header)
        stream.write(struct.pack("<I", len(mesh.triangles)))
        for triangle in mesh.triangles:
            normal = _triangle_normal(*triangle)
            stream.write(struct.pack("<3f", *normal))
            for point in triangle:
                stream.write(struct.pack("<3f", *point))
            stream.write(struct.pack("<H", 0))


def _triangle_normal(a, b, c) -> tuple[float, float, float]:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    normal = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    length = math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2])
    if length <= 1e-12:
        return (0.0, 0.0, 0.0)
    return (normal[0] / length, normal[1] / length, normal[2] / length)


def _triangle_area2(a, b, c) -> float:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    return cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]


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
