from __future__ import annotations

from dataclasses import dataclass
from math import cos, radians, sin

from .errors import ConfigError
from .mesh import Mesh, Point3


@dataclass(frozen=True)
class MeshTransform:
    rotate_x_deg: float = 0.0
    rotate_y_deg: float = 0.0
    rotate_z_deg: float = 0.0
    scale: float = 1.0
    translate_x_mm: float = 0.0
    translate_y_mm: float = 0.0
    translate_z_mm: float = 0.0

    def validate(self) -> None:
        if self.scale <= 0:
            raise ConfigError("scale must be positive")


def apply_transform(mesh: Mesh, transform: MeshTransform) -> Mesh:
    transform.validate()
    if transform == MeshTransform():
        return mesh

    bounds = mesh.bounds()
    origin = (
        (bounds.min_x + bounds.max_x) / 2.0,
        (bounds.min_y + bounds.max_y) / 2.0,
        (bounds.min_z + bounds.max_z) / 2.0,
    )

    rx = radians(transform.rotate_x_deg)
    ry = radians(transform.rotate_y_deg)
    rz = radians(transform.rotate_z_deg)
    cx, sx = cos(rx), sin(rx)
    cy, sy = cos(ry), sin(ry)
    cz, sz = cos(rz), sin(rz)

    def map_point(point: Point3) -> Point3:
        x = (point[0] - origin[0]) * transform.scale
        y = (point[1] - origin[1]) * transform.scale
        z = (point[2] - origin[2]) * transform.scale

        y, z = y * cx - z * sx, y * sx + z * cx
        x, z = x * cy + z * sy, -x * sy + z * cy
        x, y = x * cz - y * sz, x * sz + y * cz

        return (
            x + origin[0] + transform.translate_x_mm,
            y + origin[1] + transform.translate_y_mm,
            z + origin[2] + transform.translate_z_mm,
        )

    return Mesh(tuple(tuple(map_point(point) for point in tri) for tri in mesh.triangles))  # type: ignore[misc]
