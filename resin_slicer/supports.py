from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import atan, ceil, cos, floor, pi, radians, sin, sqrt, tan
from typing import Callable

from .config import PrintConfig, SupportConfig
from .mesh import Point3, Triangle
from .raster import Component, LayerRaster, dilate_mask, mm_to_px
from .slicing import PreparedMesh, render_prepared_layer

Progress = Callable[[str], None]

_BINARY_TO_RASTER = bytes(0 if value == 0 else 255 for value in range(256))


@dataclass(frozen=True)
class _OccupiedLayer:
    layer_index: int
    raster: LayerRaster
    min_x: int
    min_y: int
    max_x: int
    max_y: int


@dataclass(frozen=True)
class SupportAnchor:
    x: int
    y: int
    top_layer: int
    base_x: int | None = None
    base_y: int | None = None
    base_layer: int = 0
    joint_x: int | None = None
    joint_y: int | None = None
    joint_layer: int | None = None
    tip_type: str = "cone"
    kind: str = "bed"
    role: str = "secondary"
    normal_x: float = 0.0
    normal_y: float = 0.0
    normal_z: float = -1.0


@dataclass(frozen=True)
class _AnchorCandidate:
    x: int
    y: int
    spacing_mm: float
    role: str


@dataclass(frozen=True)
class _Surface:
    triangle: Triangle
    normal: Point3


@dataclass(frozen=True)
class SupportBrace:
    x0: int
    y0: int
    x1: int
    y1: int
    start_layer: int
    end_layer: int
    radius_px: int


@dataclass(frozen=True)
class SupportPlan:
    anchors: tuple[SupportAnchor, ...]
    post_radius_px: int
    tip_radius_px: int
    foot_radius_px: int
    joint_sphere_radius_mm: float
    raft_layers: int
    braces: tuple[SupportBrace, ...] = ()
    bed_interface: str = "raft"
    raft_radius_px: int = 0
    brace_layer_radius: int = 0
    spherical_contact_enabled: bool = False
    contact_sphere_radius_mm: float = 0.0
    contact_sphere_inset_mm: float = 0.0
    pixel_size_x_mm: float = 1.0
    pixel_size_y_mm: float = 1.0
    layer_height_mm: float = 1.0
    raft_mask: bytes | None = None
    raft_shadow_mask: bytes | None = None
    raft_offset_px: int = 0
    raft_chamfer_width_mm: float = 0.0
    raft_chamfer_angle_deg: float = 45.0


def plan_supports(
    prepared: PreparedMesh,
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    progress: Progress | None = None,
) -> SupportPlan:
    support.validate()
    output_pixel_mm = min(config.pixel_size_x_mm, config.pixel_size_y_mm)
    post_radius = mm_to_px(support.post_radius_mm, output_pixel_mm)
    tip_radius = mm_to_px(support.tip_radius_mm, output_pixel_mm)
    foot_radius = mm_to_px(support.foot_radius_mm, output_pixel_mm)
    raft_radius = mm_to_px(support.foot_radius_mm + support.raft_margin_mm, output_pixel_mm)
    brace_radius = mm_to_px(support.brace_radius_mm, output_pixel_mm)
    brace_layer_radius = max(0, int(ceil(support.brace_radius_mm / config.layer_height_mm)))
    joint_sphere_radius_mm = max(support.post_radius_mm, support.tip_radius_mm)
    contact_sphere_radius_mm = max(0.0, support.spherical_contact_diameter_mm * 0.5)
    bed_interface_layers = 0 if support.bed_interface == "none" else max(
        1,
        int(ceil(support.bed_interface_thickness_mm / config.layer_height_mm)),
    )
    raft_mask, raft_shadow_mask, raft_offset_px = _projected_raft_masks(prepared, config, support)

    analysis_config = _analysis_config(config, support)
    analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    lookback_layers = _overhang_lookback_layers(analysis_config, support, analysis_pixel_mm)
    min_area_px = max(1, int(ceil(support.min_island_area_mm2 / analysis_config.pixel_area_mm2)))
    body_collision_radius = mm_to_px(max(support.post_radius_mm, support.tip_radius_mm), analysis_pixel_mm)
    collision_radius = mm_to_px(
        max(support.post_radius_mm, support.tip_radius_mm) + support.collision_clearance_mm,
        analysis_pixel_mm,
    )
    history: deque[LayerRaster] = deque(maxlen=lookback_layers)
    occupied_layers: list[_OccupiedLayer] = []
    anchors: list[SupportAnchor] = []
    placed_points: list[tuple[int, int]] = []
    surface_normals = _SurfaceNormalSampler(prepared.mesh.triangles)

    interval = max(1, layer_count // 20)
    for layer_index in range(layer_count):
        if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
            progress(f"support analysis layer {layer_index + 1}/{layer_count}")

        current = render_prepared_layer(prepared, analysis_config, layer_index)
        base_layer = history[0] if history else LayerRaster(analysis_config.resolution_x, analysis_config.resolution_y)
        overhang_px = _overhang_allowance_px(
            analysis_config,
            support,
            analysis_pixel_mm,
            max(1, len(history)),
        )
        support_mask = dilate_mask(base_layer, overhang_px)
        unsupported = current.unsupported_mask(support_mask)
        components = current.connected_components(unsupported, min_area_px)

        for component in components:
            for candidate in _anchor_candidates(component, analysis_config, support):
                x, y = candidate.x, candidate.y
                out_x, out_y = _scale_point_to_output(x, y, analysis_config, config)
                if _too_close_to_existing(placed_points, out_x, out_y, config, candidate.spacing_mm):
                    continue
                fallback_normal = _estimate_surface_normal(current, base_layer, analysis_config, x, y)
                contact_point = (
                    (x + 0.5) * analysis_config.pixel_size_x_mm,
                    (y + 0.5) * analysis_config.pixel_size_y_mm,
                    (layer_index + 0.5) * analysis_config.layer_height_mm,
                )
                normal = surface_normals.normal_at_contact(contact_point, fallback_normal)

                route = _find_support_route(
                    occupied_layers,
                    analysis_config,
                    support,
                    x,
                    y,
                    layer_index,
                    normal,
                    body_collision_radius,
                    collision_radius,
                    candidate.role,
                )
                if route is None:
                    continue

                out_anchor = _scale_anchor_to_output(route, analysis_config, config)
                placed_points.append((out_anchor.x, out_anchor.y))
                anchors.append(out_anchor)

        history.append(current)
        occupied = _occupied_layer(layer_index, current)
        if occupied is not None:
            occupied_layers.append(occupied)

    braces = _plan_braces(anchors, prepared, config, support, layer_count, brace_radius, bed_interface_layers)
    return SupportPlan(
        tuple(anchors),
        post_radius,
        tip_radius,
        foot_radius,
        joint_sphere_radius_mm,
        bed_interface_layers,
        braces=braces,
        bed_interface=support.bed_interface,
        raft_radius_px=raft_radius,
        brace_layer_radius=brace_layer_radius,
        spherical_contact_enabled=support.spherical_contact_enabled,
        contact_sphere_radius_mm=contact_sphere_radius_mm,
        contact_sphere_inset_mm=support.spherical_contact_inset_mm,
        pixel_size_x_mm=config.pixel_size_x_mm,
        pixel_size_y_mm=config.pixel_size_y_mm,
        layer_height_mm=config.layer_height_mm,
        raft_mask=raft_mask,
        raft_shadow_mask=raft_shadow_mask,
        raft_offset_px=raft_offset_px,
        raft_chamfer_width_mm=support.raft_chamfer_width_mm,
        raft_chamfer_angle_deg=support.raft_chamfer_angle_deg,
    )


def apply_supports(layer: LayerRaster, layer_index: int, plan: SupportPlan) -> None:
    if layer_index < plan.raft_layers and plan.bed_interface in {"raft", "skate"}:
        _apply_raft_mask(layer, plan, layer_index)

    for brace in plan.braces:
        if brace.start_layer - plan.brace_layer_radius <= layer_index <= brace.end_layer + plan.brace_layer_radius:
            x, y = _brace_center(brace, layer_index)
            layer.add_disk(x, y, brace.radius_px, 255)

    for anchor in plan.anchors:
        if layer_index < anchor.base_layer or layer_index > anchor.top_layer:
            continue

        base_x, base_y = _base_xy(anchor)
        if anchor.kind == "bed" and anchor.base_layer == 0 and layer_index < plan.raft_layers and plan.bed_interface == "feet":
            layer.add_disk(base_x, base_y, _bed_radius(plan), 255)

        x, y = _support_center(anchor, layer_index)
        radius = _support_radius_at_layer(anchor, layer_index, plan)
        layer.add_disk(x, y, radius, 255)
        _add_joint_sphere(layer, layer_index, anchor, plan)
        if plan.spherical_contact_enabled:
            _add_spherical_contact(layer, layer_index, anchor, plan)


def _projected_raft_masks(prepared: PreparedMesh, config: PrintConfig, support: SupportConfig) -> tuple[bytes | None, bytes | None, int]:
    if support.bed_interface not in {"raft", "skate"}:
        return None, None, 0

    shadow = LayerRaster(config.resolution_x, config.resolution_y)
    for triangle in prepared.mesh.triangles:
        _add_projected_triangle(shadow, triangle, config)

    if shadow.count_on() == 0:
        return None, None, 0

    offset_px = 0
    if support.raft_margin_mm > 0:
        offset_px = mm_to_px(support.raft_margin_mm, min(config.pixel_size_x_mm, config.pixel_size_y_mm))
    full_mask = bytes(dilate_mask(shadow, offset_px).translate(_BINARY_TO_RASTER))
    return full_mask, bytes(shadow.pixels), offset_px


def _add_projected_triangle(layer: LayerRaster, triangle: Triangle, config: PrintConfig) -> None:
    projected = tuple((point[0] / config.pixel_size_x_mm, point[1] / config.pixel_size_y_mm) for point in triangle)
    area2 = (
        (projected[1][0] - projected[0][0]) * (projected[2][1] - projected[0][1])
        - (projected[1][1] - projected[0][1]) * (projected[2][0] - projected[0][0])
    )
    if abs(area2) < 1e-6:
        return

    min_y = max(0, int(floor(min(point[1] for point in projected))))
    max_y = min(layer.height - 1, int(ceil(max(point[1] for point in projected))) - 1)
    if min_y > max_y:
        return

    for y in range(min_y, max_y + 1):
        scan_y = y + 0.5
        intersections: list[float] = []
        for edge_index in range(3):
            x0, y0 = projected[edge_index]
            x1, y1 = projected[(edge_index + 1) % 3]
            if y0 == y1:
                continue
            if (y0 <= scan_y < y1) or (y1 <= scan_y < y0):
                t = (scan_y - y0) / (y1 - y0)
                intersections.append(x0 + (x1 - x0) * t)
        if len(intersections) < 2:
            continue
        intersections.sort()
        for index in range(0, len(intersections) - 1, 2):
            x0 = int(floor(intersections[index]))
            x1 = int(ceil(intersections[index + 1])) - 1
            layer.set_span(y, x0, x1, 255)


def _apply_raft_mask(layer: LayerRaster, plan: SupportPlan, layer_index: int) -> None:
    mask = _raft_mask_for_layer(plan, layer_index, layer.width, layer.height)
    if not mask:
        return
    if layer.count_on() == 0:
        layer.pixels[:] = mask
        return
    for index, value in enumerate(mask):
        if value:
            layer.pixels[index] = 255


def _raft_mask_for_layer(plan: SupportPlan, layer_index: int, width: int, height: int) -> bytes | None:
    if not plan.raft_mask:
        return None
    inset_px = _raft_chamfer_inset_px(plan, layer_index)
    if inset_px <= 0 or not plan.raft_shadow_mask:
        return plan.raft_mask
    effective_offset_px = max(0, plan.raft_offset_px - inset_px)
    if effective_offset_px >= plan.raft_offset_px:
        return plan.raft_mask
    shadow = LayerRaster(width, height, bytearray(plan.raft_shadow_mask))
    return bytes(dilate_mask(shadow, effective_offset_px).translate(_BINARY_TO_RASTER))


def _raft_chamfer_inset_px(plan: SupportPlan, layer_index: int) -> int:
    if plan.raft_chamfer_width_mm <= 0:
        return 0
    z_mm = (layer_index + 0.5) * plan.layer_height_mm
    inset_mm = plan.raft_chamfer_width_mm - z_mm * tan(radians(plan.raft_chamfer_angle_deg))
    if inset_mm <= 0:
        return 0
    return int(ceil(inset_mm / min(plan.pixel_size_x_mm, plan.pixel_size_y_mm)))


def _overhang_allowance_px(
    config: PrintConfig,
    support: SupportConfig,
    pixel_mm: float,
    gap_layers: int,
) -> int:
    angle = radians(support.overhang_angle_deg)
    allowance_mm = config.layer_height_mm * gap_layers / tan(angle) + support.overhang_margin_mm
    return max(0, int(floor(allowance_mm / pixel_mm)))


def _overhang_lookback_layers(
    config: PrintConfig,
    support: SupportConfig,
    pixel_mm: float,
) -> int:
    angle = radians(support.overhang_angle_deg)
    allowance_per_layer_mm = config.layer_height_mm / tan(angle)
    if allowance_per_layer_mm <= 0:
        return 1
    return max(1, min(24, int(ceil(pixel_mm / allowance_per_layer_mm))))


class _SurfaceNormalSampler:
    def __init__(self, triangles: tuple[Triangle, ...]) -> None:
        self.surfaces = tuple(surface for tri in triangles if (surface := _surface_from_triangle(tri)) is not None)

    def normal_at_contact(
        self,
        point: Point3,
        fallback: tuple[float, float, float],
    ) -> tuple[float, float, float]:
        if not self.surfaces:
            return fallback
        nearest = min(self.surfaces, key=lambda surface: _point_triangle_distance2(point, surface.triangle))
        aligned: list[tuple[float, Point3]] = []
        for surface in self.surfaces:
            if _dot3(nearest.normal, surface.normal) <= 0.95:
                continue
            aligned.append((_point_triangle_distance2(point, surface.triangle), surface.normal))
        if not aligned:
            return nearest.normal
        aligned.sort(key=lambda item: item[0])
        return _average_normals(tuple(normal for _distance, normal in aligned[:30]))


def _surface_from_triangle(triangle: Triangle) -> _Surface | None:
    a, b, c = triangle
    normal = _cross3(_sub3(b, a), _sub3(c, a))
    if _length3(normal) < 1e-9:
        return None
    return _Surface(triangle, _normalize_downward(normal))


def _average_normals(normals: tuple[Point3, ...]) -> tuple[float, float, float]:
    if not normals:
        return (0.0, 0.0, -1.0)
    total = (0.0, 0.0, 0.0)
    for normal in normals:
        total = _add3(total, normal)
    return _normalize_downward(total)


def _estimate_surface_normal(
    current: LayerRaster,
    below: LayerRaster,
    config: PrintConfig,
    x: int,
    y: int,
) -> tuple[float, float, float]:
    center = _occupied_at(current, x, y)
    if not center:
        return (0.0, 0.0, -1.0)
    dx = _occupied_at(current, x + 1, y) - _occupied_at(current, x - 1, y)
    dy = _occupied_at(current, x, y + 1) - _occupied_at(current, x, y - 1)
    dz = center - _occupied_at(below, x, y)
    normal = (
        -dx / max(config.pixel_size_x_mm, 1e-6),
        -dy / max(config.pixel_size_y_mm, 1e-6),
        -dz / max(config.layer_height_mm, 1e-6),
    )
    return _normalize_downward(normal)


def _occupied_at(layer: LayerRaster, x: int, y: int) -> int:
    if x < 0 or y < 0 or x >= layer.width or y >= layer.height:
        return 0
    return 1 if layer.pixels[y * layer.width + x] else 0


def _tip_direction_from_normal(normal: tuple[float, float, float]) -> tuple[float, float, float]:
    return _normalize_downward(normal)


def _normalize_downward(vector: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = vector
    if z > 0:
        x, y, z = -x, -y, -z
    length = _length3((x, y, z))
    if length < 1e-6:
        return (0.0, 0.0, -1.0)
    x, y, z = x / length, y / length, z / length
    if z > -0.05:
        return _normalize_downward((x * 0.35, y * 0.35, -1.0))
    return (x, y, z)


def _length3(vector: tuple[float, float, float]) -> float:
    return sqrt(vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2])


def _dot3(a: Point3, b: Point3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub3(a: Point3, b: Point3) -> Point3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _add3(a: Point3, b: Point3) -> Point3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _scale3(vector: Point3, scale: float) -> Point3:
    return (vector[0] * scale, vector[1] * scale, vector[2] * scale)


def _cross3(a: Point3, b: Point3) -> Point3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _point_triangle_distance2(point: Point3, triangle: Triangle) -> float:
    closest = _closest_point_on_triangle(point, triangle)
    delta = _sub3(point, closest)
    return _dot3(delta, delta)


def _closest_point_on_triangle(point: Point3, triangle: Triangle) -> Point3:
    a, b, c = triangle
    ab = _sub3(b, a)
    ac = _sub3(c, a)
    ap = _sub3(point, a)
    d1 = _dot3(ab, ap)
    d2 = _dot3(ac, ap)
    if d1 <= 0.0 and d2 <= 0.0:
        return a

    bp = _sub3(point, b)
    d3 = _dot3(ab, bp)
    d4 = _dot3(ac, bp)
    if d3 >= 0.0 and d4 <= d3:
        return b

    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        v = d1 / (d1 - d3)
        return _add3(a, _scale3(ab, v))

    cp = _sub3(point, c)
    d5 = _dot3(ab, cp)
    d6 = _dot3(ac, cp)
    if d6 >= 0.0 and d5 <= d6:
        return c

    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        w = d2 / (d2 - d6)
        return _add3(a, _scale3(ac, w))

    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        return _add3(b, _scale3(_sub3(c, b), w))

    denom = 1.0 / (va + vb + vc)
    v = vb * denom
    w = vc * denom
    return _add3(a, _add3(_scale3(ab, v), _scale3(ac, w)))


def _analysis_config(config: PrintConfig, support: SupportConfig) -> PrintConfig:
    pixels = config.resolution_x * config.resolution_y
    if pixels <= support.analysis_max_pixels:
        return config

    scale = (support.analysis_max_pixels / pixels) ** 0.5
    resolution_x = max(64, int(config.resolution_x * scale))
    resolution_y = max(64, int(config.resolution_y * scale))
    return config.with_overrides(
        resolution_x=resolution_x,
        resolution_y=resolution_y,
        max_pixels_per_layer=max(config.max_pixels_per_layer, resolution_x * resolution_y),
    )


def _find_support_route(
    occupied_layers: list[_OccupiedLayer],
    config: PrintConfig,
    support: SupportConfig,
    top_x: int,
    top_y: int,
    top_layer: int,
    normal: tuple[float, float, float],
    body_collision_radius: int,
    collision_radius: int,
    role: str,
) -> SupportAnchor | None:
    route = _build_route(config, support, top_x, top_y, top_layer, normal, top_x, top_y, 0, "bed", role)
    joint_x, joint_y = _joint_xy(route)
    if 0 <= joint_x < config.resolution_x and 0 <= joint_y < config.resolution_y:
        if not _route_collides(occupied_layers, config.resolution_x, config.resolution_y, route, body_collision_radius):
            return route

    if support.enforcers_enabled:
        return _find_enforcer_route(
            occupied_layers,
            config,
            support,
            top_x,
            top_y,
            top_layer,
            normal,
            collision_radius,
            role,
        )
    return None


def _find_enforcer_route(
    occupied_layers: list[_OccupiedLayer],
    config: PrintConfig,
    support: SupportConfig,
    top_x: int,
    top_y: int,
    top_layer: int,
    normal: tuple[float, float, float],
    collision_radius: int,
    role: str,
) -> SupportAnchor | None:
    min_drop_layers = max(1, int(ceil(support.enforcer_min_drop_mm / config.layer_height_mm)))
    max_drop_layers = max(min_drop_layers, int(ceil(support.enforcer_reach_mm / config.layer_height_mm)))
    min_base_layer = max(0, top_layer - max_drop_layers)
    for occupied in reversed(occupied_layers):
        if occupied.layer_index >= top_layer - min_drop_layers:
            continue
        if occupied.layer_index < min_base_layer:
            break
        route = _build_route(
            config,
            support,
            top_x,
            top_y,
            top_layer,
            normal,
            top_x,
            top_y,
            occupied.layer_index,
            "enforcer",
            role,
        )
        base_x, base_y = _base_xy(route)
        if base_x < occupied.min_x or base_x > occupied.max_x or base_y < occupied.min_y or base_y > occupied.max_y:
            continue
        if not occupied.raster.pixels[base_y * config.resolution_x + base_x]:
            continue
        if not _route_collides(occupied_layers, config.resolution_x, config.resolution_y, route, collision_radius):
            return route
    return None


def _build_route(
    config: PrintConfig,
    support: SupportConfig,
    top_x: int,
    top_y: int,
    top_layer: int,
    normal: tuple[float, float, float],
    base_x: int,
    base_y: int,
    base_layer: int,
    kind: str,
    role: str,
) -> SupportAnchor:
    span_layers = max(1, top_layer - base_layer)
    direction = _tip_direction_from_normal(normal)
    vertical_drop_mm = max(config.layer_height_mm, abs(direction[2]) * support.tip_length_mm)
    tip_layers = min(span_layers, max(1, int(ceil(vertical_drop_mm / config.layer_height_mm))))
    joint_layer = max(base_layer, top_layer - tip_layers)
    drop_mm = max(config.layer_height_mm, (top_layer - joint_layer) * config.layer_height_mm)
    travel_mm = drop_mm / max(0.05, -direction[2])
    joint_x = int(round(top_x + direction[0] * travel_mm / config.pixel_size_x_mm))
    joint_y = int(round(top_y + direction[1] * travel_mm / config.pixel_size_y_mm))

    return SupportAnchor(
        x=top_x,
        y=top_y,
        top_layer=top_layer,
        base_x=joint_x,
        base_y=joint_y,
        base_layer=base_layer,
        joint_x=joint_x,
        joint_y=joint_y,
        joint_layer=joint_layer,
        tip_type=support.tip_type,
        kind=kind,
        role=role,
        normal_x=normal[0],
        normal_y=normal[1],
        normal_z=normal[2],
    )


def _route_collides(
    occupied_layers: list[_OccupiedLayer],
    width: int,
    height: int,
    anchor: SupportAnchor,
    radius: int,
) -> bool:
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
    for occupied in occupied_layers:
        if occupied.layer_index < anchor.base_layer:
            continue
        if occupied.layer_index > joint_layer:
            break
        if anchor.kind == "enforcer" and occupied.layer_index <= anchor.base_layer + 1:
            continue
        x, y = _support_center(anchor, occupied.layer_index)
        if (
            x + radius < occupied.min_x
            or x - radius > occupied.max_x
            or y + radius < occupied.min_y
            or y - radius > occupied.max_y
        ):
            continue
        if _disk_collides(occupied.raster.pixels, width, height, x, y, radius):
            return True
    return False


def _occupied_layer(layer_index: int, layer: LayerRaster) -> _OccupiedLayer | None:
    min_x = layer.width
    min_y = layer.height
    max_x = -1
    max_y = -1
    for start, end in layer.nonzero_spans():
        y = start // layer.width
        x0 = start % layer.width
        x1 = (end - 1) % layer.width
        min_x = min(min_x, x0)
        min_y = min(min_y, y)
        max_x = max(max_x, x1)
        max_y = max(max_y, y)
    if max_x < 0:
        return None
    return _OccupiedLayer(layer_index, layer, min_x, min_y, max_x, max_y)


def _disk_collides(
    occupied: bytearray,
    width: int,
    height: int,
    x: int,
    y: int,
    radius: int,
) -> bool:
    radius = max(0, radius)
    radius2 = radius * radius
    for yy in range(max(0, y - radius), min(height, y + radius + 1)):
        dy = yy - y
        dx = int(floor(sqrt(max(0, radius2 - dy * dy))))
        x0 = max(0, x - dx)
        x1 = min(width, x + dx + 1)
        base = yy * width
        if occupied[base + x0 : base + x1].find(255) != -1:
            return True
    return False


def _support_angle_deg(anchor: SupportAnchor, config: PrintConfig) -> float:
    base_x, base_y = _base_xy(anchor)
    joint_x, joint_y = _joint_xy(anchor)
    base_layer = anchor.base_layer
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(base_layer, anchor.top_layer - 1)
    vertical_mm = max(config.layer_height_mm, (joint_layer - base_layer) * config.layer_height_mm)
    dx_mm = (joint_x - base_x) * config.pixel_size_x_mm
    dy_mm = (joint_y - base_y) * config.pixel_size_y_mm
    horizontal_mm = sqrt(dx_mm * dx_mm + dy_mm * dy_mm)
    return 180.0 / pi * atan(horizontal_mm / vertical_mm)


def _plan_braces(
    anchors: list[SupportAnchor],
    prepared: PreparedMesh,
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    radius_px: int,
    bed_interface_layers: int,
) -> tuple[SupportBrace, ...]:
    brace_anchors = [anchor for anchor in anchors if anchor.kind == "bed" and anchor.base_layer == 0]
    if not support.brace_enabled or len(brace_anchors) < 2:
        return ()

    if support.brace_height_mm < 0:
        return ()
    start_layer = max(bed_interface_layers, int(round(support.brace_height_mm / config.layer_height_mm)))
    if start_layer >= layer_count:
        return ()
    max_distance_px = max(
        1,
        int(round(support.brace_max_distance_mm / min(config.pixel_size_x_mm, config.pixel_size_y_mm))),
    )
    min_distance_px = max(1, radius_px * 4)
    collision_radius_px = radius_px + _clearance_px(support.collision_clearance_mm, config)

    centers = [_support_center(anchor, min(start_layer, anchor.top_layer)) for anchor in brace_anchors]
    model_layers: dict[int, LayerRaster] = {}
    braces: list[SupportBrace] = []
    seen: set[tuple[int, int]] = set()
    for i, (x0, y0) in enumerate(centers):
        candidates: list[tuple[int, int]] = []
        for j in range(i + 1, len(centers)):
            x1, y1 = centers[j]
            dx = x1 - x0
            dy = y1 - y0
            d2 = dx * dx + dy * dy
            if min_distance_px * min_distance_px <= d2 <= max_distance_px * max_distance_px:
                candidates.append((d2, j))
        candidates.sort()
        for _d2, j in candidates[:2]:
            pair = (i, j)
            if pair in seen:
                continue
            seen.add(pair)
            brace = _diagonal_brace_between(
                brace_anchors[i],
                brace_anchors[j],
                start_layer,
                layer_count,
                radius_px,
                collision_radius_px,
                prepared,
                config,
                model_layers,
            )
            if brace is not None:
                braces.append(brace)
    return tuple(braces)


def _diagonal_brace_between(
    first: SupportAnchor,
    second: SupportAnchor,
    start_layer: int,
    layer_count: int,
    radius_px: int,
    collision_radius_px: int,
    prepared: PreparedMesh,
    config: PrintConfig,
    model_layers: dict[int, LayerRaster],
) -> SupportBrace | None:
    for source, target in ((first, second), (second, first)):
        brace = _make_diagonal_brace(source, target, start_layer, layer_count, radius_px, config)
        if brace is not None and not _brace_collides_with_model(brace, collision_radius_px, prepared, config, model_layers):
            return brace
    return None


def _make_diagonal_brace(
    source: SupportAnchor,
    target: SupportAnchor,
    start_layer: int,
    layer_count: int,
    radius_px: int,
    config: PrintConfig,
) -> SupportBrace | None:
    source_joint_layer = _joint_layer(source)
    target_joint_layer = _joint_layer(target)
    if start_layer > source_joint_layer:
        return None

    x0, y0 = _support_center(source, start_layer)
    x1, y1 = _support_center(target, min(start_layer, target_joint_layer))
    dx_mm = (x1 - x0) * config.pixel_size_x_mm
    dy_mm = (y1 - y0) * config.pixel_size_y_mm
    horizontal_mm = sqrt(dx_mm * dx_mm + dy_mm * dy_mm)
    if horizontal_mm <= 0:
        return None
    end_layer = start_layer + max(1, int(round(horizontal_mm / config.layer_height_mm)))
    if end_layer >= layer_count or end_layer > target_joint_layer:
        return None
    return SupportBrace(x0, y0, x1, y1, start_layer, end_layer, radius_px)


def _brace_collides_with_model(
    brace: SupportBrace,
    radius_px: int,
    prepared: PreparedMesh,
    config: PrintConfig,
    model_layers: dict[int, LayerRaster],
) -> bool:
    for layer_index in range(max(0, brace.start_layer), min(brace.end_layer, prepared.layer_count - 1) + 1):
        layer = model_layers.get(layer_index)
        if layer is None:
            layer = render_prepared_layer(prepared, config, layer_index)
            model_layers[layer_index] = layer
        x, y = _brace_center(brace, layer_index)
        if _disk_collides(layer.pixels, layer.width, layer.height, x, y, radius_px):
            return True
    return False


def _brace_center(brace: SupportBrace, layer_index: int) -> tuple[int, int]:
    if brace.end_layer <= brace.start_layer:
        return brace.x0, brace.y0
    t = (layer_index - brace.start_layer) / (brace.end_layer - brace.start_layer)
    t = min(1.0, max(0.0, t))
    return (
        int(round(brace.x0 + (brace.x1 - brace.x0) * t)),
        int(round(brace.y0 + (brace.y1 - brace.y0) * t)),
    )


def _joint_layer(anchor: SupportAnchor) -> int:
    return anchor.joint_layer if anchor.joint_layer is not None else max(anchor.base_layer, anchor.top_layer - 1)


def _clearance_px(clearance_mm: float, config: PrintConfig) -> int:
    if clearance_mm <= 0:
        return 0
    return int(ceil(clearance_mm / min(config.pixel_size_x_mm, config.pixel_size_y_mm)))


def _scale_anchor_to_output(
    anchor: SupportAnchor,
    analysis_config: PrintConfig,
    output_config: PrintConfig,
) -> SupportAnchor:
    x, y = _scale_point_to_output(anchor.x, anchor.y, analysis_config, output_config)
    base_x, base_y = _scale_point_to_output(*_base_xy(anchor), analysis_config, output_config)
    joint_x, joint_y = _scale_point_to_output(*_joint_xy(anchor), analysis_config, output_config)
    return SupportAnchor(
        x=x,
        y=y,
        top_layer=anchor.top_layer,
        base_x=base_x,
        base_y=base_y,
        base_layer=anchor.base_layer,
        joint_x=joint_x,
        joint_y=joint_y,
        joint_layer=anchor.joint_layer,
        tip_type=anchor.tip_type,
        kind=anchor.kind,
        role=anchor.role,
        normal_x=anchor.normal_x,
        normal_y=anchor.normal_y,
        normal_z=anchor.normal_z,
    )


def _scale_point_to_output(
    x: int,
    y: int,
    analysis_config: PrintConfig,
    output_config: PrintConfig,
) -> tuple[int, int]:
    sx = output_config.resolution_x / analysis_config.resolution_x
    sy = output_config.resolution_y / analysis_config.resolution_y
    out_x = int(round((x + 0.5) * sx - 0.5))
    out_y = int(round((y + 0.5) * sy - 0.5))
    return (
        min(max(0, out_x), output_config.resolution_x - 1),
        min(max(0, out_y), output_config.resolution_y - 1),
    )


def _support_center(anchor: SupportAnchor, layer_index: int) -> tuple[int, int]:
    base_x, base_y = _base_xy(anchor)
    joint_x, joint_y = _joint_xy(anchor)
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)

    if anchor.top_layer <= 0:
        return anchor.x, anchor.y
    if layer_index <= joint_layer:
        if joint_layer <= anchor.base_layer:
            return base_x, base_y
        t = (layer_index - anchor.base_layer) / max(1, joint_layer - anchor.base_layer)
        return (
            int(round(base_x + (joint_x - base_x) * t)),
            int(round(base_y + (joint_y - base_y) * t)),
        )

    tip_layers = max(1, anchor.top_layer - joint_layer)
    t = (layer_index - joint_layer) / tip_layers
    return (
        int(round(joint_x + (anchor.x - joint_x) * t)),
        int(round(joint_y + (anchor.y - joint_y) * t)),
    )


def _support_radius_at_layer(anchor: SupportAnchor, layer_index: int, plan: SupportPlan) -> int:
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
    if anchor.kind == "enforcer" and layer_index == anchor.base_layer:
        return plan.tip_radius_px
    if layer_index <= joint_layer or anchor.top_layer <= joint_layer:
        return plan.post_radius_px

    t = (layer_index - joint_layer) / max(1, anchor.top_layer - joint_layer)
    if anchor.tip_type == "cylinder":
        return plan.tip_radius_px if layer_index == anchor.top_layer else plan.post_radius_px
    if anchor.tip_type == "sphere":
        cone_radius = _lerp(plan.post_radius_px, plan.tip_radius_px, t)
        bulb_radius = max(plan.post_radius_px * 1.45, plan.tip_radius_px * 2.2)
        sphere_radius = plan.tip_radius_px + (bulb_radius - plan.tip_radius_px) * sin(pi * t)
        return max(1, int(round(max(cone_radius, sphere_radius))))
    return max(1, int(round(_lerp(plan.post_radius_px, plan.tip_radius_px, t))))


def _add_joint_sphere(layer: LayerRaster, layer_index: int, anchor: SupportAnchor, plan: SupportPlan) -> None:
    radius_mm = plan.joint_sphere_radius_mm
    if radius_mm <= 0:
        return
    joint_x, joint_y = _joint_xy(anchor)
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
    dz_mm = (layer_index - joint_layer) * plan.layer_height_mm
    if abs(dz_mm) > radius_mm:
        return
    radius_at_layer_mm = sqrt(max(0.0, radius_mm * radius_mm - dz_mm * dz_mm))
    radius_px = max(1, int(round(radius_at_layer_mm / min(plan.pixel_size_x_mm, plan.pixel_size_y_mm))))
    layer.add_disk(joint_x, joint_y, radius_px, 255)


def _add_spherical_contact(layer: LayerRaster, layer_index: int, anchor: SupportAnchor, plan: SupportPlan) -> None:
    radius_mm = plan.contact_sphere_radius_mm
    if radius_mm <= 0:
        return
    inset_mm = min(max(0.0, plan.contact_sphere_inset_mm), radius_mm * 2.0)
    offset_mm = radius_mm - inset_mm
    center_x = anchor.x + anchor.normal_x * offset_mm / max(plan.pixel_size_x_mm, 1e-6)
    center_y = anchor.y + anchor.normal_y * offset_mm / max(plan.pixel_size_y_mm, 1e-6)
    center_layer = anchor.top_layer + anchor.normal_z * offset_mm / max(plan.layer_height_mm, 1e-6)
    dz_mm = (layer_index - center_layer) * plan.layer_height_mm
    if abs(dz_mm) > radius_mm:
        return
    radius_at_layer_mm = sqrt(max(0.0, radius_mm * radius_mm - dz_mm * dz_mm))
    radius_px = max(1, int(round(radius_at_layer_mm / min(plan.pixel_size_x_mm, plan.pixel_size_y_mm))))
    layer.add_disk(int(round(center_x)), int(round(center_y)), radius_px, 255)


def _bed_radius(plan: SupportPlan) -> int:
    if plan.bed_interface == "feet":
        return plan.foot_radius_px
    if plan.bed_interface == "skate":
        return max(plan.foot_radius_px, plan.raft_radius_px + plan.foot_radius_px // 2)
    return max(plan.foot_radius_px, plan.raft_radius_px)


def _base_xy(anchor: SupportAnchor) -> tuple[int, int]:
    return (
        anchor.base_x if anchor.base_x is not None else anchor.x,
        anchor.base_y if anchor.base_y is not None else anchor.y,
    )


def _joint_xy(anchor: SupportAnchor) -> tuple[int, int]:
    return (
        anchor.joint_x if anchor.joint_x is not None else anchor.x,
        anchor.joint_y if anchor.joint_y is not None else anchor.y,
    )


def _lerp(a: int, b: int, t: float) -> float:
    return a + (b - a) * t


def _anchor_candidates(
    component: Component,
    config: PrintConfig,
    support: SupportConfig,
) -> list[_AnchorCandidate]:
    cx, cy = component.centroid(config.resolution_x)
    primary_spacing_mm = support.support_spacing_mm
    primary_enabled = support.primary_supports_enabled and support.primary_max_extra_per_island > 0
    if primary_enabled:
        primary_spacing_mm = max(
            support.post_radius_mm * 3.0,
            support.support_spacing_mm / support.primary_density_multiplier,
        )

    candidates: list[_AnchorCandidate] = []

    def append_candidate(x: int, y: int, spacing_mm: float, role: str) -> None:
        x = min(max(0, int(x)), config.resolution_x - 1)
        y = min(max(0, int(y)), config.resolution_y - 1)
        for existing in candidates:
            if existing.x == x and existing.y == y:
                return
        candidates.append(_AnchorCandidate(x, y, spacing_mm, role))

    append_candidate(round(cx), round(cy), primary_spacing_mm if primary_enabled else support.support_spacing_mm, "primary")

    if primary_enabled:
        primary_stride_x = max(1, int(round(primary_spacing_mm / config.pixel_size_x_mm)))
        primary_stride_y = max(1, int(round(primary_spacing_mm / config.pixel_size_y_mm)))
        radius_px = max(1, int(round(support.primary_area_radius_mm / min(config.pixel_size_x_mm, config.pixel_size_y_mm))))
        radius2 = radius_px * radius_px
        center_x = round(cx)
        center_y = round(cy)
        primary_buckets: dict[tuple[int, int], int] = {}
        for index in component.pixels:
            x = index % config.resolution_x
            y = index // config.resolution_x
            dx = x - center_x
            dy = y - center_y
            if dx * dx + dy * dy > radius2:
                continue
            bucket = ((x - component.min_x) // primary_stride_x, (y - component.min_y) // primary_stride_y)
            primary_buckets.setdefault(bucket, index)
            if len(primary_buckets) >= support.primary_max_extra_per_island:
                break
        for index in primary_buckets.values():
            append_candidate(index % config.resolution_x, index // config.resolution_x, primary_spacing_mm, "primary")

    stride_x = max(1, int(round(support.support_spacing_mm / config.pixel_size_x_mm)))
    stride_y = max(1, int(round(support.support_spacing_mm / config.pixel_size_y_mm)))
    buckets: dict[tuple[int, int], int] = {}
    for index in component.pixels:
        x = index % config.resolution_x
        y = index // config.resolution_x
        bucket = ((x - component.min_x) // stride_x, (y - component.min_y) // stride_y)
        buckets.setdefault(bucket, index)
        if len(buckets) >= support.max_supports_per_island:
            break

    for index in buckets.values():
        append_candidate(index % config.resolution_x, index // config.resolution_x, support.support_spacing_mm, "secondary")

    return candidates[: support.max_supports_per_island + support.primary_max_extra_per_island]


def _too_close_to_existing(
    points: list[tuple[int, int]],
    x: int,
    y: int,
    config: PrintConfig,
    spacing_mm: float,
) -> bool:
    min_distance2 = spacing_mm * spacing_mm
    for other_x, other_y in points:
        dx_mm = (x - other_x) * config.pixel_size_x_mm
        dy_mm = (y - other_y) * config.pixel_size_y_mm
        if dx_mm * dx_mm + dy_mm * dy_mm < min_distance2:
            return True
    return False
