from __future__ import annotations

from dataclasses import dataclass
from math import ceil, floor

from .config import PrintConfig
from .errors import ConfigError, MeshError
from .mesh import Mesh, Point3, Triangle
from .raster import LayerRaster

Segment = tuple[tuple[float, float], tuple[float, float]]


@dataclass(frozen=True)
class PreparedMesh:
    mesh: Mesh
    layer_count: int
    height_mm: float
    layer_triangles: tuple[tuple[Triangle, ...], ...]


def prepare_mesh(
    mesh: Mesh,
    config: PrintConfig,
    z_offset_mm: float = 0.0,
    xy_offset_mm: tuple[float, float] = (0.0, 0.0),
    preserve_coordinates: bool = False,
) -> PreparedMesh:
    bounds = mesh.bounds()
    if bounds.width <= 0 or bounds.depth <= 0 or bounds.height <= 0:
        raise MeshError("mesh bounds are degenerate")
    if preserve_coordinates:
        min_x = bounds.min_x + xy_offset_mm[0]
        max_x = bounds.max_x + xy_offset_mm[0]
        min_y = bounds.min_y + xy_offset_mm[1]
        max_y = bounds.max_y + xy_offset_mm[1]
        if min_x < 0 or min_y < 0 or max_x > config.size_x_mm or max_y > config.size_y_mm:
            raise ConfigError(
                f"mesh footprint spans {min_x:.2f},{min_y:.2f} to {max_x:.2f},{max_y:.2f}mm, "
                f"outside build area {config.size_x_mm:.2f}x{config.size_y_mm:.2f}mm"
            )
    elif bounds.width > config.size_x_mm or bounds.depth > config.size_y_mm:
        raise ConfigError(
            f"mesh footprint {bounds.width:.2f}x{bounds.depth:.2f}mm exceeds "
            f"build area {config.size_x_mm:.2f}x{config.size_y_mm:.2f}mm"
        )
    if z_offset_mm < 0:
        raise ConfigError("Z offset cannot be negative")
    final_min_z = bounds.min_z + z_offset_mm if preserve_coordinates else z_offset_mm
    final_max_z = bounds.max_z + z_offset_mm if preserve_coordinates else bounds.height + z_offset_mm
    if final_min_z < 0:
        raise ConfigError("mesh cannot extend below the build plate")
    if final_max_z > config.size_z_mm:
        raise ConfigError(
            f"mesh height {bounds.height:.2f}mm plus {z_offset_mm:.2f}mm lift exceeds "
            f"build height {config.size_z_mm:.2f}mm"
        )

    if preserve_coordinates:
        ox = xy_offset_mm[0]
        oy = xy_offset_mm[1]
    elif config.center_model:
        ox = (config.size_x_mm - bounds.width) / 2.0 - bounds.min_x + xy_offset_mm[0]
        oy = (config.size_y_mm - bounds.depth) / 2.0 - bounds.min_y + xy_offset_mm[1]
    else:
        ox = -bounds.min_x + xy_offset_mm[0]
        oy = -bounds.min_y + xy_offset_mm[1]
    oz = z_offset_mm if preserve_coordinates else z_offset_mm - bounds.min_z

    transformed = mesh.transformed((ox, oy, oz))
    total_height = final_max_z
    layer_count = config.layer_count_for_height(total_height)
    return PreparedMesh(transformed, layer_count, total_height, _build_layer_index(transformed, config, layer_count))


def render_model_layer(mesh: Mesh, config: PrintConfig, layer_index: int) -> LayerRaster:
    z = (layer_index + 0.5) * config.layer_height_mm
    segments = _slice_segments(mesh, z)
    return _rasterize_segments(segments, config)


def render_prepared_layer(prepared: PreparedMesh, config: PrintConfig, layer_index: int) -> LayerRaster:
    z = (layer_index + 0.5) * config.layer_height_mm
    segments = _slice_segments_from_triangles(prepared.layer_triangles[layer_index], z)
    return _rasterize_segments(segments, config)


def rasterize_segments(segments: list[Segment], config: PrintConfig) -> LayerRaster:
    return _rasterize_segments(segments, config)


def _build_layer_index(mesh: Mesh, config: PrintConfig, layer_count: int) -> tuple[tuple[Triangle, ...], ...]:
    buckets: list[list[Triangle]] = [[] for _ in range(layer_count)]
    height = config.layer_height_mm
    for triangle in mesh.triangles:
        min_z = min(point[2] for point in triangle)
        max_z = max(point[2] for point in triangle)
        if max_z <= min_z:
            continue
        first = max(0, int(ceil(min_z / height - 0.5)))
        last = min(layer_count - 1, int(ceil(max_z / height - 0.5)) - 1)
        if first > last:
            continue
        for layer_index in range(first, last + 1):
            buckets[layer_index].append(triangle)
    return tuple(tuple(bucket) for bucket in buckets)


def _slice_segments(mesh: Mesh, z: float) -> list[Segment]:
    return _slice_segments_from_triangles(mesh.triangles, z)


def _slice_segments_from_triangles(triangles: tuple[Triangle, ...], z: float) -> list[Segment]:
    # Each segment is oriented consistently with the triangle's winding (outward
    # normal), so that overlapping/unioned solids accumulate a nonzero winding
    # number in _rasterize_segments instead of cancelling out under even-odd fill.
    segments: list[Segment] = []
    for tri in triangles:
        below = [tri[0][2] <= z, tri[1][2] <= z, tri[2][2] <= z]
        below_count = sum(below)
        if below_count == 0 or below_count == 3:
            continue
        if below_count == 1:
            lone = below.index(True)
            lone_is_below = True
        else:
            lone = below.index(False)
            lone_is_below = False
        pred = (lone - 1) % 3
        succ = (lone + 1) % 3
        point_pred = _edge_intersection(tri[lone], tri[pred], z)
        point_succ = _edge_intersection(tri[lone], tri[succ], z)
        if point_pred is None or point_succ is None:
            continue
        segment = (point_pred, point_succ) if lone_is_below else (point_succ, point_pred)
        if _distance2(segment[0], segment[1]) > 1e-16:
            segments.append(segment)
    return segments


def _edge_intersection(a: Point3, b: Point3, z: float) -> tuple[float, float] | None:
    az = a[2]
    bz = b[2]
    if az == bz:
        return None
    if (az <= z < bz) or (bz <= z < az):
        t = (z - az) / (bz - az)
        return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return None


def _rasterize_segments(segments: list[Segment], config: PrintConfig) -> LayerRaster:
    width = config.resolution_x
    height = config.resolution_y
    pixel_x = config.pixel_size_x_mm
    pixel_y = config.pixel_size_y_mm
    raster = LayerRaster(width, height)
    if not segments:
        return raster

    buckets: list[list[Segment]] = [[] for _ in range(height)]
    for segment in segments:
        (_, y1), (_, y2) = segment
        ymin = min(y1, y2)
        ymax = max(y1, y2)
        if ymax <= 0 or ymin >= config.size_y_mm:
            continue
        first = max(0, int(floor(ymin / pixel_y - 0.5)))
        last = min(height - 1, int(ceil(ymax / pixel_y - 0.5)))
        for y in range(first, last + 1):
            y_mm = (y + 0.5) * pixel_y
            if ymin <= y_mm < ymax:
                buckets[y].append(segment)

    for y, row_segments in enumerate(buckets):
        if not row_segments:
            continue
        y_mm = (y + 0.5) * pixel_y
        # Crossings carry a winding sign so overlapping/unioned solids fill their
        # union (nonzero winding number) rather than cancelling under even-odd pairing.
        crossings: list[tuple[float, int]] = []
        for (x1, y1), (x2, y2) in row_segments:
            if y1 == y2:
                continue
            ymin = min(y1, y2)
            ymax = max(y1, y2)
            if not (ymin <= y_mm < ymax):
                continue
            t = (y_mm - y1) / (y2 - y1)
            x = x1 + t * (x2 - x1)
            crossings.append((x, 1 if y2 > y1 else -1))

        crossings.sort(key=lambda c: c[0])

        winding = 0
        span_start: float | None = None
        for x, sign in crossings:
            was_outside = winding == 0
            winding += sign
            if was_outside and winding != 0:
                span_start = x
            elif not was_outside and winding == 0 and span_start is not None:
                left = max(0.0, span_start)
                right = min(config.size_x_mm, x)
                span_start = None
                if right <= left:
                    continue
                x0 = int(ceil(left / pixel_x - 0.5))
                x1 = int(floor(right / pixel_x - 0.5))
                raster.set_span(y, x0, x1, 255)
    return raster


def _distance2(a: tuple[float, float], b: tuple[float, float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy
