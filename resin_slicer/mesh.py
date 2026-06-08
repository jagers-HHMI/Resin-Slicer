from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

from .errors import MeshError

Point3 = tuple[float, float, float]
Triangle = tuple[Point3, Point3, Point3]


@dataclass(frozen=True)
class Bounds:
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float

    @property
    def width(self) -> float:
        return self.max_x - self.min_x

    @property
    def depth(self) -> float:
        return self.max_y - self.min_y

    @property
    def height(self) -> float:
        return self.max_z - self.min_z


@dataclass(frozen=True)
class Mesh:
    triangles: tuple[Triangle, ...]

    def bounds(self) -> Bounds:
        if not self.triangles:
            raise MeshError("mesh contains no triangles")
        xs: list[float] = []
        ys: list[float] = []
        zs: list[float] = []
        for tri in self.triangles:
            for x, y, z in tri:
                xs.append(x)
                ys.append(y)
                zs.append(z)
        return Bounds(min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

    def transformed(self, offset: Point3) -> "Mesh":
        ox, oy, oz = offset
        return Mesh(
            tuple(
                tuple((x + ox, y + oy, z + oz) for x, y, z in tri)  # type: ignore[misc]
                for tri in self.triangles
            )
        )


def load_stl(path: str | Path) -> Mesh:
    payload = Path(path).read_bytes()
    if len(payload) < 84:
        raise MeshError("STL file is too small")

    if _looks_like_binary_stl(payload):
        return _load_binary_stl(payload)
    return _load_ascii_stl(payload.decode("utf-8", errors="replace"))


def load_obj(path: str | Path) -> Mesh:
    return _load_obj(Path(path).read_text(encoding="utf-8", errors="replace"))


def load_step(path: str | Path) -> Mesh:
    from .step import step_to_mesh

    return step_to_mesh(path)


def load_mesh(path: str | Path) -> Mesh:
    suffix = Path(path).suffix.lower()
    if suffix == ".obj":
        return load_obj(path)
    if suffix == ".stl":
        return load_stl(path)
    if suffix in {".stp", ".step"}:
        return load_step(path)
    raise MeshError(f"unsupported mesh format {suffix or '<none>'}; expected .stl, .obj, .stp, or .step")


def _looks_like_binary_stl(payload: bytes) -> bool:
    count = struct.unpack_from("<I", payload, 80)[0]
    return 84 + count * 50 == len(payload)


def _load_binary_stl(payload: bytes) -> Mesh:
    count = struct.unpack_from("<I", payload, 80)[0]
    triangles: list[Triangle] = []
    offset = 84
    for _ in range(count):
        if offset + 50 > len(payload):
            raise MeshError("binary STL ended mid-triangle")
        values = struct.unpack_from("<12fH", payload, offset)
        p1 = (values[3], values[4], values[5])
        p2 = (values[6], values[7], values[8])
        p3 = (values[9], values[10], values[11])
        if _triangle_area2(p1, p2, p3) > 1e-12:
            triangles.append((p1, p2, p3))
        offset += 50
    if not triangles:
        raise MeshError("binary STL contains no non-degenerate triangles")
    return Mesh(tuple(triangles))


def _load_ascii_stl(text: str) -> Mesh:
    vertices: list[Point3] = []
    triangles: list[Triangle] = []
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            try:
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError as exc:
                raise MeshError(f"invalid ASCII STL vertex line: {line!r}") from exc
            if len(vertices) == 3:
                p1, p2, p3 = vertices
                if _triangle_area2(p1, p2, p3) > 1e-12:
                    triangles.append((p1, p2, p3))
                vertices = []
    if not triangles:
        raise MeshError("ASCII STL contains no triangles")
    return Mesh(tuple(triangles))


def _load_obj(text: str) -> Mesh:
    vertices: list[Point3] = []
    triangles: list[Triangle] = []
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        kind = parts[0].lower()
        if kind == "v":
            if len(parts) < 4:
                raise MeshError(f"invalid OBJ vertex line: {raw_line!r}")
            try:
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            except ValueError as exc:
                raise MeshError(f"invalid OBJ vertex line: {raw_line!r}") from exc
        elif kind == "f":
            if len(parts) < 4:
                raise MeshError(f"invalid OBJ face line: {raw_line!r}")
            face = [_obj_vertex(vertices, token, raw_line) for token in parts[1:]]
            for index in range(1, len(face) - 1):
                tri = (face[0], face[index], face[index + 1])
                if _triangle_area2(*tri) > 1e-12:
                    triangles.append(tri)
    if not triangles:
        raise MeshError("OBJ contains no non-degenerate faces")
    return Mesh(tuple(triangles))


def _obj_vertex(vertices: list[Point3], token: str, raw_line: str) -> Point3:
    index_text = token.split("/", 1)[0]
    if not index_text:
        raise MeshError(f"invalid OBJ face line: {raw_line!r}")
    try:
        index = int(index_text)
    except ValueError as exc:
        raise MeshError(f"invalid OBJ face line: {raw_line!r}") from exc
    if index == 0:
        raise MeshError(f"OBJ vertex indices are 1-based: {raw_line!r}")
    resolved = index - 1 if index > 0 else len(vertices) + index
    if resolved < 0 or resolved >= len(vertices):
        raise MeshError(f"OBJ face references missing vertex {index}: {raw_line!r}")
    return vertices[resolved]


def _triangle_area2(a: Point3, b: Point3, c: Point3) -> float:
    ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
    ac = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
    cross = (
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    )
    return cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]


def cube_mesh(size: float = 10.0) -> Mesh:
    s = size
    v = [
        (0.0, 0.0, 0.0),
        (s, 0.0, 0.0),
        (s, s, 0.0),
        (0.0, s, 0.0),
        (0.0, 0.0, s),
        (s, 0.0, s),
        (s, s, s),
        (0.0, s, s),
    ]
    faces = [
        (0, 2, 1), (0, 3, 2),
        (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4),
        (1, 2, 6), (1, 6, 5),
        (2, 3, 7), (2, 7, 6),
        (3, 0, 4), (3, 4, 7),
    ]
    return Mesh(tuple((v[a], v[b], v[c]) for a, b, c in faces))
