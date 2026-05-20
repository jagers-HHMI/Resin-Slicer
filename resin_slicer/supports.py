from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import atan, ceil, cos, floor, pi, radians, sin, sqrt, tan
from typing import Callable

from .config import PrintConfig, SupportConfig
from .raster import Component, LayerRaster, dilate_mask, mm_to_px
from .slicing import PreparedMesh, render_prepared_layer

Progress = Callable[[str], None]
VERTICAL_TIP_REACH_MM = 1.5


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


@dataclass(frozen=True)
class _AnchorCandidate:
    x: int
    y: int
    spacing_mm: float
    role: str


@dataclass(frozen=True)
class SupportBrace:
    x0: int
    y0: int
    x1: int
    y1: int
    layer: int
    radius_px: int


@dataclass(frozen=True)
class SupportPlan:
    anchors: tuple[SupportAnchor, ...]
    post_radius_px: int
    tip_radius_px: int
    foot_radius_px: int
    raft_layers: int
    braces: tuple[SupportBrace, ...] = ()
    bed_interface: str = "raft"
    raft_radius_px: int = 0
    brace_layer_radius: int = 0


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

    analysis_config = _analysis_config(config, support)
    analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    lookback_layers = _overhang_lookback_layers(analysis_config, support, analysis_pixel_mm)
    min_area_px = max(1, int(ceil(support.min_island_area_mm2 / analysis_config.pixel_area_mm2)))
    body_collision_radius = mm_to_px(max(support.post_radius_mm, support.tip_radius_mm), analysis_pixel_mm)
    collision_radius = mm_to_px(
        max(support.post_radius_mm, support.tip_radius_mm) + support.collision_clearance_mm,
        analysis_pixel_mm,
    )
    base_offsets = _base_search_offsets(support, analysis_pixel_mm)
    enforcer_offsets = _enforcer_search_offsets(support, analysis_pixel_mm)

    history: deque[LayerRaster] = deque(maxlen=lookback_layers)
    occupied_layers: list[_OccupiedLayer] = []
    anchors: list[SupportAnchor] = []
    placed_points: list[tuple[int, int]] = []

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

                route = _find_support_route(
                    occupied_layers,
                    analysis_config,
                    support,
                    x,
                    y,
                    layer_index,
                    body_collision_radius,
                    collision_radius,
                    base_offsets,
                    enforcer_offsets,
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

    braces = _plan_braces(anchors, config, support, layer_count, brace_radius)
    return SupportPlan(
        tuple(anchors),
        post_radius,
        tip_radius,
        foot_radius,
        support.raft_layers,
        braces=braces,
        bed_interface=support.bed_interface,
        raft_radius_px=raft_radius,
        brace_layer_radius=brace_layer_radius,
    )


def apply_supports(layer: LayerRaster, layer_index: int, plan: SupportPlan) -> None:
    for brace in plan.braces:
        if abs(layer_index - brace.layer) <= plan.brace_layer_radius:
            layer.add_capsule(brace.x0, brace.y0, brace.x1, brace.y1, brace.radius_px, 255)

    for anchor in plan.anchors:
        if layer_index < anchor.base_layer or layer_index > anchor.top_layer:
            continue

        base_x, base_y = _base_xy(anchor)
        if anchor.kind == "bed" and anchor.base_layer == 0 and layer_index < plan.raft_layers and plan.bed_interface != "none":
            layer.add_disk(base_x, base_y, _bed_radius(plan), 255)

        x, y = _support_center(anchor, layer_index)
        radius = _support_radius_at_layer(anchor, layer_index, plan)
        layer.add_disk(x, y, radius, 255)


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
    body_collision_radius: int,
    collision_radius: int,
    base_offsets: tuple[tuple[int, int], ...],
    enforcer_offsets: tuple[tuple[int, int], ...],
    role: str,
) -> SupportAnchor | None:
    for dx, dy in base_offsets:
        base_x = top_x + dx
        base_y = top_y + dy
        if base_x < 0 or base_y < 0 or base_x >= config.resolution_x or base_y >= config.resolution_y:
            continue

        route = _build_route(config, support, top_x, top_y, top_layer, base_x, base_y, 0, "bed", role)
        if _support_angle_deg(route, config) > support.max_support_angle_deg:
            continue
        joint_x, joint_y = _joint_xy(route)
        if joint_x < 0 or joint_y < 0 or joint_x >= config.resolution_x or joint_y >= config.resolution_y:
            continue
        route_radius = body_collision_radius if dx == 0 and dy == 0 else collision_radius
        if not _route_collides(occupied_layers, config.resolution_x, config.resolution_y, route, route_radius):
            return route

    if support.enforcers_enabled:
        return _find_enforcer_route(
            occupied_layers,
            config,
            support,
            top_x,
            top_y,
            top_layer,
            collision_radius,
            enforcer_offsets,
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
    collision_radius: int,
    enforcer_offsets: tuple[tuple[int, int], ...],
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
        for dx, dy in enforcer_offsets:
            base_x = top_x + dx
            base_y = top_y + dy
            if base_x < occupied.min_x or base_x > occupied.max_x or base_y < occupied.min_y or base_y > occupied.max_y:
                continue
            if not occupied.raster.pixels[base_y * config.resolution_x + base_x]:
                continue
            route = _build_route(
                config,
                support,
                top_x,
                top_y,
                top_layer,
                base_x,
                base_y,
                occupied.layer_index,
                "enforcer",
                role,
            )
            if _support_angle_deg(route, config) > support.max_support_angle_deg:
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
    base_x: int,
    base_y: int,
    base_layer: int,
    kind: str,
    role: str,
) -> SupportAnchor:
    span_layers = max(1, top_layer - base_layer)
    tip_layers = min(span_layers, max(1, int(ceil(support.tip_length_mm / config.layer_height_mm))))
    joint_layer = max(0, top_layer - tip_layers)
    if joint_layer == 0:
        joint_x, joint_y = base_x, base_y
    else:
        vx = base_x - top_x
        vy = base_y - top_y
        length = sqrt(vx * vx + vy * vy)
        if length <= 0:
            joint_x, joint_y = top_x, top_y
        else:
            pixel_mm = min(config.pixel_size_x_mm, config.pixel_size_y_mm)
            max_vertical_tip_mm = max(
                tan(radians(support.tip_angle_deg)) * support.tip_length_mm,
                support.post_radius_mm * 4.0,
                VERTICAL_TIP_REACH_MM,
            )
            if length * pixel_mm <= max_vertical_tip_mm:
                joint_x, joint_y = base_x, base_y
            else:
                offset_px = min(length, max_vertical_tip_mm / pixel_mm)
                joint_x = int(round(top_x + vx / length * offset_px))
                joint_y = int(round(top_y + vy / length * offset_px))

    return SupportAnchor(
        x=top_x,
        y=top_y,
        top_layer=top_layer,
        base_x=base_x,
        base_y=base_y,
        base_layer=base_layer,
        joint_x=joint_x,
        joint_y=joint_y,
        joint_layer=joint_layer,
        tip_type=support.tip_type,
        kind=kind,
        role=role,
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


def _base_search_offsets(support: SupportConfig, pixel_mm: float) -> tuple[tuple[int, int], ...]:
    max_reach_px = max(1, int(ceil(support.max_base_reach_mm / pixel_mm)))
    step_mm = max(support.support_spacing_mm, support.post_radius_mm * 6.0)
    step_px = max(1, int(round(step_mm / pixel_mm)))
    rings = [
        step_px,
        step_px * 2,
        step_px * 4,
        max_reach_px,
    ]
    directions = 12
    offsets: list[tuple[int, int]] = [(0, 0)]
    seen = {(0, 0)}
    for radius in sorted({min(max_reach_px, ring) for ring in rings if ring > 0}):
        for index in range(directions):
            angle = index * 2.0 * pi / directions
            dx = int(round(cos(angle) * radius))
            dy = int(round(sin(angle) * radius))
            if (dx, dy) in seen:
                continue
            seen.add((dx, dy))
            offsets.append((dx, dy))
    return tuple(offsets)


def _enforcer_search_offsets(support: SupportConfig, pixel_mm: float) -> tuple[tuple[int, int], ...]:
    max_reach_px = max(1, int(ceil(support.enforcer_reach_mm / pixel_mm)))
    step_px = max(1, int(round(max(support.support_spacing_mm * 0.5, support.post_radius_mm * 4.0) / pixel_mm)))
    offsets: list[tuple[int, int]] = [(0, 0)]
    seen = {(0, 0)}
    directions = 12
    for radius in range(step_px, max_reach_px + 1, step_px):
        for index in range(directions):
            angle = index * 2.0 * pi / directions
            dx = int(round(cos(angle) * radius))
            dy = int(round(sin(angle) * radius))
            if (dx, dy) in seen:
                continue
            seen.add((dx, dy))
            offsets.append((dx, dy))
    return tuple(offsets)


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
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    radius_px: int,
) -> tuple[SupportBrace, ...]:
    brace_anchors = [anchor for anchor in anchors if anchor.kind == "bed" and anchor.base_layer == 0]
    if not support.brace_enabled or len(brace_anchors) < 2:
        return ()

    safe_height = support.model_lift_mm - support.collision_clearance_mm - support.brace_radius_mm
    if safe_height <= config.layer_height_mm:
        return ()
    brace_z = min(support.brace_height_mm, safe_height)
    brace_layer = min(layer_count - 1, max(support.raft_layers, int(round(brace_z / config.layer_height_mm))))
    max_distance_px = max(
        1,
        int(round(support.brace_max_distance_mm / min(config.pixel_size_x_mm, config.pixel_size_y_mm))),
    )
    min_distance_px = max(1, radius_px * 4)

    centers = [_support_center(anchor, min(brace_layer, anchor.top_layer)) for anchor in brace_anchors]
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
            x1, y1 = centers[j]
            braces.append(SupportBrace(x0, y0, x1, y1, brace_layer, radius_px))
    return tuple(braces)


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
