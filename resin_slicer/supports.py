from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
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
    # Number of contact tips this shaft carries: 1 for a plain support, higher
    # for a tree trunk that other shafts merged into.
    load: int = 1
    # For trunks: one entry per merged child, (junction_layer, ex_mm, ey_mm)
    # where e is the child contact's horizontal offset from the trunk axis.
    # Junction layers and mm offsets are resolution-independent, so these
    # survive analysis/output rescaling untouched. The trunk radius at a layer
    # is solved from the cumulative load and net moment of the children joining
    # above that layer (see _trunk_radius_scale).
    junctions: tuple[tuple[int, float, float], ...] = ()


@dataclass(frozen=True)
class PaintZone:
    """A painted brush sample on the model surface, in the same mm space as
    manual support points. ``exclude`` zones block automatic anchors whose
    contact point falls inside the brush sphere; ``require`` zones ask the
    planner to grow supports on the painted surface."""

    x: float
    y: float
    z: float
    radius: float
    mode: str = "exclude"  # "exclude" or "require"


@dataclass(frozen=True)
class _AnchorCandidate:
    x: int
    y: int
    spacing_mm: float
    role: str


@dataclass(frozen=True)
class _MeshCandidate:
    """A contact candidate derived from the mesh itself (full float precision)
    rather than from the downsampled analysis raster."""

    x: int
    y: int
    layer_index: int
    spacing_mm: float
    role: str
    point_mm: Point3


@dataclass(frozen=True)
class _Surface:
    triangle: Triangle
    normal: Point3
    min_x: float
    min_y: float
    min_z: float
    max_x: float
    max_y: float
    max_z: float


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
class ResidualIsland:
    """A connected model region that is still floating (no cured material below
    it) after the planned supports were stamped into the layer stack."""

    x_mm: float
    y_mm: float
    z_mm: float
    area_mm2: float
    layer_index: int


@dataclass(frozen=True)
class SuctionCup:
    """A downward-opening cavity that seals at the top: each peel has to pull
    against the vacuum inside it. Position is the mouth centroid; volume is
    the enclosed cavity volume."""

    x_mm: float
    y_mm: float
    z_mm: float
    mouth_area_mm2: float
    height_mm: float
    volume_mm3: float


@dataclass(frozen=True)
class SupportReport:
    """Diagnostics from support planning. failed_routes counts contact points
    (automatic, manual, painted, or rescue) that could not be routed to the bed
    or model; rescue_count is how many extra supports the closed-loop
    verification added; residual_islands lists regions that remain unsupported
    in the final plan; suction_cups lists sealed downward-opening cavities.
    verified is False when the verification pass was skipped (manual-only
    planning)."""

    failed_routes: int = 0
    rescue_count: int = 0
    residual_islands: tuple[ResidualIsland, ...] = ()
    suction_cups: tuple[SuctionCup, ...] = ()
    verified: bool = False


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
    # Needed to solve trunk radii from junction data at stamping time.
    post_radius_mm: float = 0.28
    tree_stress_factor: float = 8.0


def plan_supports(
    prepared: PreparedMesh,
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    progress: Progress | None = None,
    include_raft_mask: bool = True,
    on_anchor: Callable[[SupportAnchor], None] | None = None,
    manual_points: tuple[tuple[float, float, float], ...] = (),
    manual_only: bool = False,
    paint_zones: tuple[PaintZone, ...] = (),
) -> SupportPlan:
    plan, _report = plan_supports_verified(
        prepared,
        config,
        support,
        layer_count,
        progress=progress,
        include_raft_mask=include_raft_mask,
        on_anchor=on_anchor,
        manual_points=manual_points,
        manual_only=manual_only,
        paint_zones=paint_zones,
        verify=False,
    )
    return plan


def plan_supports_verified(
    prepared: PreparedMesh,
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    progress: Progress | None = None,
    include_raft_mask: bool = True,
    on_anchor: Callable[[SupportAnchor], None] | None = None,
    manual_points: tuple[tuple[float, float, float], ...] = (),
    manual_only: bool = False,
    paint_zones: tuple[PaintZone, ...] = (),
    verify: bool = True,
    max_rescue_passes: int = 3,
) -> tuple[SupportPlan, SupportReport]:
    """Plan supports, then verify the result by stamping the supports into the
    layer stack and re-running island detection on the combined rasters. Any
    region still floating gets rescue supports (same routing machinery as the
    auto planner), and whatever remains unsupported after the rescue passes is
    reported so the caller can surface it instead of silently printing a
    failure. Verification is skipped for manual-only planning, which must never
    invent supports the user did not ask for."""
    support.validate()
    exclude_zones = tuple(zone for zone in paint_zones if zone.mode == "exclude")
    require_zones = tuple(zone for zone in paint_zones if zone.mode == "require")
    output_pixel_mm = min(config.pixel_size_x_mm, config.pixel_size_y_mm)
    brace_radius = mm_to_px(support.brace_radius_mm, output_pixel_mm)
    bed_interface_layers = 0 if support.bed_interface == "none" else max(
        1,
        int(ceil(support.bed_interface_thickness_mm / config.layer_height_mm)),
    )
    raft_mask, raft_shadow_mask, raft_offset_px = (
        _projected_raft_masks(prepared, config, support) if include_raft_mask else (None, None, 0)
    )

    analysis_config = _analysis_config(config, support)
    analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    lookback_layers = _overhang_lookback_layers(analysis_config, support, analysis_pixel_mm)
    min_area_px = max(1, int(ceil(support.min_island_area_mm2 / analysis_config.pixel_area_mm2)))
    collision_radius = mm_to_px(
        max(support.post_radius_mm, support.tip_radius_mm) + support.collision_clearance_mm,
        analysis_pixel_mm,
    )
    history: deque[LayerRaster] = deque(maxlen=lookback_layers)
    occupied_layers: list[_OccupiedLayer] = []
    anchors: list[SupportAnchor] = []
    placed_points = _PlacedPointIndex(config)
    surface_normals = _SurfaceNormalSampler(prepared.mesh.triangles)
    failed_contacts: list[_FailedContact] = []
    mesh_candidates: dict[int, list[_MeshCandidate]] = {}
    if not manual_only and support.mesh_minima_enabled:
        mesh_candidates = _minima_contact_candidates(
            prepared.mesh.triangles, analysis_config, support, layer_count
        )

    interval = max(1, layer_count // 20)
    for layer_index in range(layer_count):
        if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
            progress(f"support analysis layer {layer_index + 1}/{layer_count}")

        current = render_prepared_layer(prepared, analysis_config, layer_index)
        occupied = _occupied_layer(layer_index, current)

        # Mesh-derived minima route before this layer's raster candidates so
        # the true first-contact points win the spacing contest. They also run
        # when the layer rasterises empty — a feature smaller than an analysis
        # pixel still needs its support.
        for candidate in mesh_candidates.get(layer_index, ()):
            out_x, out_y = _scale_point_to_output(candidate.x, candidate.y, analysis_config, config)
            if placed_points.too_close(out_x, out_y, candidate.spacing_mm):
                continue
            if exclude_zones and _in_paint_zones(candidate.point_mm, exclude_zones):
                continue
            below = history[-1] if history else LayerRaster(analysis_config.resolution_x, analysis_config.resolution_y)
            fallback_normal = _estimate_surface_normal(current, below, analysis_config, candidate.x, candidate.y)
            normal = surface_normals.normal_at_contact(candidate.point_mm, fallback_normal)
            route = _find_support_route(
                occupied_layers,
                analysis_config,
                support,
                candidate.x,
                candidate.y,
                layer_index,
                normal,
                collision_radius,
                candidate.role,
            )
            if route is None:
                failed_contacts.append(
                    _FailedContact(candidate.x, candidate.y, layer_index, normal, candidate.role, candidate.spacing_mm)
                )
                continue
            out_anchor = _scale_anchor_to_output(route, analysis_config, config)
            placed_points.add(out_anchor.x, out_anchor.y)
            anchors.append(out_anchor)
            if on_anchor is not None:
                on_anchor(out_anchor)

        if occupied is None:
            # Empty layer (e.g. the model-lift gap or an internal void): there is
            # nothing here to support or to collide against, so skip the costly
            # dilation / unsupported-mask / connected-component analysis entirely.
            if not manual_only:
                history.append(current)
            continue

        if manual_only:
            # Manual-only pass: we still need the per-layer occupied geometry so
            # user points can route down to the model/bed, but the automatic
            # overhang detection and candidate placement are skipped entirely.
            occupied_layers.append(occupied)
            continue

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
                if placed_points.too_close(out_x, out_y, candidate.spacing_mm):
                    continue
                contact_point = (
                    (x + 0.5) * analysis_config.pixel_size_x_mm,
                    (y + 0.5) * analysis_config.pixel_size_y_mm,
                    (layer_index + 0.5) * analysis_config.layer_height_mm,
                )
                if exclude_zones and _in_paint_zones(contact_point, exclude_zones):
                    continue
                fallback_normal = _estimate_surface_normal(current, base_layer, analysis_config, x, y)
                normal = surface_normals.normal_at_contact(contact_point, fallback_normal)

                route = _find_support_route(
                    occupied_layers,
                    analysis_config,
                    support,
                    x,
                    y,
                    layer_index,
                    normal,
                    collision_radius,
                    candidate.role,
                )
                if route is None:
                    failed_contacts.append(
                        _FailedContact(x, y, layer_index, normal, candidate.role, candidate.spacing_mm)
                    )
                    continue

                out_anchor = _scale_anchor_to_output(route, analysis_config, config)
                placed_points.add(out_anchor.x, out_anchor.y)
                anchors.append(out_anchor)
                if on_anchor is not None:
                    on_anchor(out_anchor)

        history.append(current)
        occupied_layers.append(occupied)

    if manual_points:
        failed_contacts.extend(_append_point_anchors(
            manual_points,
            "manual",
            None,
            prepared,
            anchors,
            occupied_layers,
            analysis_config,
            config,
            support,
            surface_normals,
            collision_radius,
            placed_points,
            on_anchor,
            layer_count,
        ))

    if require_zones:
        # Painted "grow supports here" areas: each brush sample becomes a
        # candidate contact, thinned to the normal support spacing so a dense
        # stroke produces a sanely spaced cluster of supports.
        failed_contacts.extend(_append_point_anchors(
            tuple((zone.x, zone.y, zone.z) for zone in require_zones),
            "painted",
            support.support_spacing_mm,
            prepared,
            anchors,
            occupied_layers,
            analysis_config,
            config,
            support,
            surface_normals,
            collision_radius,
            placed_points,
            on_anchor,
            layer_count,
        ))

    # Tree merging reroutes nearby shafts into shared trunks, in place on the
    # anchors list. Manual-only passes skip it: the user placed those supports
    # deliberately, and slicing replans everything together anyway. Contacts
    # whose straight route failed then get a second chance as tree children —
    # a leaning shaft onto a trunk can reach places a pillar cannot.
    tree_builder = _TreeBuilder(
        anchors, occupied_layers, analysis_config, config, support, collision_radius, bed_interface_layers
    )
    if not manual_only:
        _merge_tree_supports(tree_builder)
        failed_contacts = _attach_failed_contacts(tree_builder, failed_contacts, placed_points, on_anchor)
    failed_routes = len(failed_contacts)

    # Manual-only passes brace among the freshly routed manual/painted anchors
    # (the existing auto supports are not visible to this pass; slicing replans
    # everything together, so cross braces to them still appear in the print).
    braces = _plan_braces(
        anchors, occupied_layers, analysis_config, config, support, layer_count, brace_radius, bed_interface_layers
    )
    plan = build_support_plan(
        tuple(anchors),
        braces,
        config,
        support,
        raft_mask=raft_mask,
        raft_shadow_mask=raft_shadow_mask,
        raft_offset_px=raft_offset_px,
    )

    rescue_count = 0
    islands: list[tuple[Component, int]] = []
    suction_cups: tuple[SuctionCup, ...] = ()
    run_verification = verify and not manual_only and layer_count > 0
    if run_verification:
        occupied_by_index = {occupied.layer_index: occupied for occupied in occupied_layers}
        suction_cups = _detect_suction_cups(occupied_by_index, analysis_config, support, layer_count)
        attempted_rescues: set[tuple[int, int, int]] = set()
        for pass_index in range(max_rescue_passes + 1):
            if progress:
                progress(f"verifying support coverage (pass {pass_index + 1})")
            islands = _unsupported_islands(
                plan, occupied_by_index, config, analysis_config, support, layer_count, min_area_px, lookback_layers
            )
            if not islands or pass_index == max_rescue_passes:
                break
            rescued, rescue_contacts = _rescue_islands(
                islands,
                occupied_layers,
                occupied_by_index,
                analysis_config,
                config,
                support,
                surface_normals,
                collision_radius,
                placed_points,
                exclude_zones,
                on_anchor,
                attempted_rescues,
            )
            anchors.extend(rescued)
            # Rescue points that could not route straight also get the tree
            # fallback before being given up on.
            recovered_start = len(anchors)
            rescue_contacts = _attach_failed_contacts(tree_builder, rescue_contacts, placed_points, on_anchor)
            added = len(rescued) + (len(anchors) - recovered_start)
            failed_routes += len(rescue_contacts)
            if not added:
                break
            rescue_count += added
            if progress:
                progress(f"added {len(rescued)} rescue support{'s' if len(rescued) != 1 else ''}")
            braces = _plan_braces(
                anchors, occupied_layers, analysis_config, config, support, layer_count, brace_radius, bed_interface_layers
            )
            plan = build_support_plan(
                tuple(anchors),
                braces,
                config,
                support,
                raft_mask=raft_mask,
                raft_shadow_mask=raft_shadow_mask,
                raft_offset_px=raft_offset_px,
            )

    report = SupportReport(
        failed_routes=failed_routes,
        rescue_count=rescue_count,
        residual_islands=tuple(
            _residual_island(component, layer_index, analysis_config) for component, layer_index in islands
        ),
        suction_cups=suction_cups,
        verified=run_verification,
    )
    return plan, report


def build_support_plan(
    anchors: tuple[SupportAnchor, ...],
    braces: tuple[SupportBrace, ...],
    config: PrintConfig,
    support: SupportConfig,
    raft_mask: bytes | None = None,
    raft_shadow_mask: bytes | None = None,
    raft_offset_px: int = 0,
    post_radius_mm: float | None = None,
    tip_radius_mm: float | None = None,
    foot_radius_mm: float | None = None,
) -> SupportPlan:
    """Assemble a SupportPlan around externally supplied anchors/braces using
    the same derived scalars plan_supports computes. Used both as plan_supports'
    final step and to rebuild a previously previewed plan for verbatim slicing."""
    output_pixel_mm = min(config.pixel_size_x_mm, config.pixel_size_y_mm)
    post_mm = support.post_radius_mm if post_radius_mm is None else max(0.01, post_radius_mm)
    tip_mm = support.tip_radius_mm if tip_radius_mm is None else max(0.01, tip_radius_mm)
    foot_mm = support.foot_radius_mm if foot_radius_mm is None else max(0.01, foot_radius_mm)
    bed_interface_layers = 0 if support.bed_interface == "none" else max(
        1,
        int(ceil(support.bed_interface_thickness_mm / config.layer_height_mm)),
    )
    return SupportPlan(
        anchors,
        mm_to_px(post_mm, output_pixel_mm),
        mm_to_px(tip_mm, output_pixel_mm),
        mm_to_px(foot_mm, output_pixel_mm),
        max(post_mm, tip_mm),
        bed_interface_layers,
        braces=braces,
        bed_interface=support.bed_interface,
        raft_radius_px=mm_to_px(foot_mm + support.raft_margin_mm, output_pixel_mm),
        brace_layer_radius=max(0, int(ceil(support.brace_radius_mm / config.layer_height_mm))),
        spherical_contact_enabled=support.spherical_contact_enabled,
        contact_sphere_radius_mm=max(0.0, support.spherical_contact_diameter_mm * 0.5),
        contact_sphere_inset_mm=support.spherical_contact_inset_mm,
        pixel_size_x_mm=config.pixel_size_x_mm,
        pixel_size_y_mm=config.pixel_size_y_mm,
        layer_height_mm=config.layer_height_mm,
        raft_mask=raft_mask,
        raft_shadow_mask=raft_shadow_mask,
        raft_offset_px=raft_offset_px,
        raft_chamfer_width_mm=support.raft_chamfer_width_mm,
        raft_chamfer_angle_deg=support.raft_chamfer_angle_deg,
        post_radius_mm=post_mm,
        tree_stress_factor=support.tree_stress_factor,
    )


def _append_point_anchors(
    points: tuple[tuple[float, float, float], ...],
    role: str,
    spacing_mm: float | None,
    prepared: PreparedMesh,
    anchors: list[SupportAnchor],
    occupied_layers: list[_OccupiedLayer],
    analysis_config: PrintConfig,
    config: PrintConfig,
    support: SupportConfig,
    surface_normals: "_SurfaceNormalSampler",
    collision_radius: int,
    placed_points: "_PlacedPointIndex",
    on_anchor: Callable[[SupportAnchor], None] | None,
    layer_count: int,
) -> list[_FailedContact]:
    """Route user-supplied contact points using the same machinery as the auto
    planner, so a manual or painted support behaves exactly as an automatic one
    would if it had chosen to anchor at that spot. Returns the points that
    could not be routed, so the caller can retry them as tree children and
    report whatever remains.

    Each point is the (x, y, z) contact location in millimetres (the same world
    coordinates the renderer draws supports in). When spacing_mm is given,
    points that land too close to an already placed support are skipped (used
    to thin dense painted strokes); manual clicks pass None and always route."""
    pixel_x = analysis_config.pixel_size_x_mm
    pixel_y = analysis_config.pixel_size_y_mm
    layer_height = analysis_config.layer_height_mm
    layer_cache: dict[int, LayerRaster] = {}

    def _layer(layer_index: int) -> LayerRaster:
        if layer_index < 0:
            return LayerRaster(analysis_config.resolution_x, analysis_config.resolution_y)
        cached = layer_cache.get(layer_index)
        if cached is None:
            cached = render_prepared_layer(prepared, analysis_config, layer_index)
            layer_cache[layer_index] = cached
        return cached

    failed: list[_FailedContact] = []
    for point in points:
        x_mm, y_mm, z_mm = float(point[0]), float(point[1]), float(point[2])
        x = min(max(0, int(round(x_mm / pixel_x - 0.5))), analysis_config.resolution_x - 1)
        y = min(max(0, int(round(y_mm / pixel_y - 0.5))), analysis_config.resolution_y - 1)
        layer_index = min(max(0, int(round(z_mm / layer_height - 0.5))), max(0, layer_count - 1))

        if spacing_mm is not None:
            out_x, out_y = _scale_point_to_output(x, y, analysis_config, config)
            if placed_points.too_close(out_x, out_y, spacing_mm):
                continue

        fallback_normal = _estimate_surface_normal(_layer(layer_index), _layer(layer_index - 1), analysis_config, x, y)
        contact_point = (x_mm, y_mm, z_mm)
        normal = surface_normals.normal_at_contact(contact_point, fallback_normal)

        route = _find_support_route(
            occupied_layers,
            analysis_config,
            support,
            x,
            y,
            layer_index,
            normal,
            collision_radius,
            role,
        )
        if route is None:
            failed.append(_FailedContact(x, y, layer_index, normal, role, spacing_mm or 0.0))
            continue

        out_anchor = _scale_anchor_to_output(route, analysis_config, config)
        placed_points.add(out_anchor.x, out_anchor.y)
        anchors.append(out_anchor)
        if on_anchor is not None:
            on_anchor(out_anchor)
    return failed


def _in_paint_zones(point: Point3, zones: tuple[PaintZone, ...]) -> bool:
    for zone in zones:
        dx = point[0] - zone.x
        dy = point[1] - zone.y
        dz = point[2] - zone.z
        if dx * dx + dy * dy + dz * dz <= zone.radius * zone.radius:
            return True
    return False


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


def attach_raft_masks(
    plan: SupportPlan,
    prepared: PreparedMesh,
    config: PrintConfig,
    support: SupportConfig,
) -> SupportPlan:
    """Fill in the projected raft masks on a plan that was built without them
    (support previews skip the masks because the viewport draws its own raft)."""
    if plan.raft_mask is not None:
        return plan
    raft_mask, raft_shadow_mask, raft_offset_px = _projected_raft_masks(prepared, config, support)
    return replace(
        plan,
        raft_mask=raft_mask,
        raft_shadow_mask=raft_shadow_mask,
        raft_offset_px=raft_offset_px,
    )


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
        self.cell_size_mm = self._cell_size()
        self.cells: dict[tuple[int, int, int], list[int]] = {}
        self._build_index()

    def normal_at_contact(
        self,
        point: Point3,
        fallback: tuple[float, float, float],
    ) -> tuple[float, float, float]:
        if not self.surfaces:
            return fallback
        surfaces = self._nearby_surfaces(point)
        nearest = min(surfaces, key=lambda surface: _point_triangle_distance2(point, surface.triangle))
        aligned: list[tuple[float, Point3]] = []
        for surface in surfaces:
            if _dot3(nearest.normal, surface.normal) <= 0.95:
                continue
            aligned.append((_point_triangle_distance2(point, surface.triangle), surface.normal))
        if not aligned:
            return nearest.normal
        aligned.sort(key=lambda item: item[0])
        return _average_normals(tuple(normal for _distance, normal in aligned[:30]))

    def _cell_size(self) -> float:
        if not self.surfaces:
            return 4.0
        min_x = min(surface.min_x for surface in self.surfaces)
        min_y = min(surface.min_y for surface in self.surfaces)
        min_z = min(surface.min_z for surface in self.surfaces)
        max_x = max(surface.max_x for surface in self.surfaces)
        max_y = max(surface.max_y for surface in self.surfaces)
        max_z = max(surface.max_z for surface in self.surfaces)
        span = max(max_x - min_x, max_y - min_y, max_z - min_z, 1.0)
        return max(4.0, span / 24.0)

    def _build_index(self) -> None:
        if not self.surfaces:
            return
        for index, surface in enumerate(self.surfaces):
            min_key = self._cell_key((surface.min_x, surface.min_y, surface.min_z))
            max_key = self._cell_key((surface.max_x, surface.max_y, surface.max_z))
            for ix in range(min_key[0], max_key[0] + 1):
                for iy in range(min_key[1], max_key[1] + 1):
                    for iz in range(min_key[2], max_key[2] + 1):
                        self.cells.setdefault((ix, iy, iz), []).append(index)

    def _nearby_surfaces(self, point: Point3) -> tuple[_Surface, ...]:
        if not self.cells:
            return self.surfaces
        center = self._cell_key(point)
        target = min(len(self.surfaces), 96)
        indices: list[int] = []
        seen: set[int] = set()
        for radius in range(5):
            for ix in range(center[0] - radius, center[0] + radius + 1):
                for iy in range(center[1] - radius, center[1] + radius + 1):
                    for iz in range(center[2] - radius, center[2] + radius + 1):
                        if radius and (
                            abs(ix - center[0]) < radius
                            and abs(iy - center[1]) < radius
                            and abs(iz - center[2]) < radius
                        ):
                            continue
                        for index in self.cells.get((ix, iy, iz), ()):
                            if index in seen:
                                continue
                            seen.add(index)
                            indices.append(index)
            if len(indices) >= target:
                break
        if not indices:
            return self.surfaces
        return tuple(self.surfaces[index] for index in indices)

    def _cell_key(self, point: Point3) -> tuple[int, int, int]:
        cell = self.cell_size_mm
        return (
            int(floor(point[0] / cell)),
            int(floor(point[1] / cell)),
            int(floor(point[2] / cell)),
        )


def _surface_from_triangle(triangle: Triangle) -> _Surface | None:
    a, b, c = triangle
    normal = _cross3(_sub3(b, a), _sub3(c, a))
    if _length3(normal) < 1e-9:
        return None
    return _Surface(
        triangle,
        _normalize_downward(normal),
        min(a[0], b[0], c[0]),
        min(a[1], b[1], c[1]),
        min(a[2], b[2], c[2]),
        max(a[0], b[0], c[0]),
        max(a[1], b[1], c[1]),
        max(a[2], b[2], c[2]),
    )


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


def _trunk_radius_scale(tips: int, net_moment_mm: float, post_radius_mm: float, stress_factor: float) -> float:
    """Smallest radius multiple rho of a lone post keeping the trunk's worst
    fiber inside the stress budget. With per-tip unit force F, a trunk of
    radius rho*r0 carrying `tips` tips and a net moment F*E sees

        sigma/sigma0 = tips/rho^2 (axial) + (4*E/r0)/rho^3 (bending),

    where sigma0 = F/(pi*r0^2) is a lone post's axial stress. Solving
    sigma/sigma0 = stress_factor gives the cubic rho^3 = a*rho + b below.
    Balanced children cancel E, so symmetric trunks stay thin (sub-linear
    area — the I ~ A^2 bending gain is what pays for consolidation), while
    one-sided branches buy real thickness. Clamped to [1, 2]."""
    if tips <= 1 and net_moment_mm <= 1e-9:
        return 1.0
    a = tips / stress_factor
    b = 4.0 * max(0.0, net_moment_mm) / (max(1e-6, post_radius_mm) * stress_factor)
    rho = max(1.0, a ** 0.5, b ** (1.0 / 3.0))
    for _ in range(24):
        f = rho * rho * rho - a * rho - b
        if abs(f) < 1e-9:
            break
        df = 3.0 * rho * rho - a
        if df <= 1e-9:
            break
        rho -= f / df
    return min(2.0, max(1.0, rho))


def _trunk_capacity_ok(tips: int, net_moment_mm: float, post_radius_mm: float, stress_factor: float) -> bool:
    """Whether the stress budget still holds at the 2x radius cap; when it
    does not, the trunk is saturated and must refuse further merges."""
    return tips / 4.0 + net_moment_mm / (2.0 * max(1e-6, post_radius_mm)) <= stress_factor


def anchor_trunk_scale(anchor: SupportAnchor, post_radius_mm: float, stress_factor: float) -> float:
    """Radius multiple of the trunk at its base (all junctions above)."""
    if not anchor.junctions:
        return 1.0
    ex = sum(junction[1] for junction in anchor.junctions)
    ey = sum(junction[2] for junction in anchor.junctions)
    return _trunk_radius_scale(
        1 + len(anchor.junctions), sqrt(ex * ex + ey * ey), post_radius_mm, stress_factor
    )


@dataclass(frozen=True)
class _FailedContact:
    """A contact point whose straight route failed; kept so the tree pass can
    try leaning it onto a trunk before it is reported as unroutable."""

    x: int  # analysis px
    y: int
    layer_index: int
    normal: tuple[float, float, float]
    role: str
    spacing_mm: float  # 0 = never thin (manual clicks)


class _TreeBuilder:
    """Trunk bookkeeping for tree merging: which anchors are trunks, where
    children join them, the running load/moment stress budget, and the
    collision state of trunks as they thicken. Children lean from their joint
    down to a junction on a trunk, bounded by max_support_angle_deg and
    max_base_reach_mm; every acceptance re-checks both the leaning shaft and
    the trunk at its new (thicker) radius against the model."""

    def __init__(
        self,
        anchors: list[SupportAnchor],
        occupied_layers: list[_OccupiedLayer],
        analysis_config: PrintConfig,
        config: PrintConfig,
        support: SupportConfig,
        collision_radius: int,
        bed_interface_layers: int,
    ) -> None:
        self.anchors = anchors
        self.occupied_layers = occupied_layers
        self.analysis_config = analysis_config
        self.config = config
        self.support = support
        self.collision_radius = collision_radius
        self.min_junction_layer = bed_interface_layers + 1
        self.tan_max = tan(radians(support.max_support_angle_deg)) if support.max_support_angle_deg > 0 else 0.0
        self.reach2 = support.max_base_reach_mm * support.max_base_reach_mm
        self.cell_mm = max(1.0, support.max_base_reach_mm)
        self.grid: dict[tuple[int, int], list[int]] = {}
        self.junctions: dict[int, list[tuple[int, float, float]]] = {}
        # Merge-loop children (they had a valid straight route and can revert
        # to it): child anchor index -> (parent index, junction entry).
        self.children: dict[int, tuple[int, tuple[int, float, float]]] = {}
        self._analysis_cache: dict[int, SupportAnchor] = {}
        self._checked_extra_px: dict[int, int] = {}
        self._analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)

    @property
    def enabled(self) -> bool:
        return self.support.tree_supports_enabled and self.tan_max > 0

    def _grid_key(self, x_px: int, y_px: int) -> tuple[int, int]:
        return (
            int(floor(x_px * self.config.pixel_size_x_mm / self.cell_mm)),
            int(floor(y_px * self.config.pixel_size_y_mm / self.cell_mm)),
        )

    def register_parent(self, index: int) -> None:
        base_x, base_y = _base_xy(self.anchors[index])
        self.grid.setdefault(self._grid_key(base_x, base_y), []).append(index)

    def _trunk_analysis(self, index: int) -> SupportAnchor:
        cached = self._analysis_cache.get(index)
        if cached is None:
            cached = _scale_anchor_to_output(self.anchors[index], self.config, self.analysis_config)
            self._analysis_cache[index] = cached
        return cached

    def _moment_sum(self, index: int, ex: float, ey: float) -> float:
        total_x = ex
        total_y = ey
        for _layer, jx, jy in self.junctions.get(index, ()):
            total_x += jx
            total_y += jy
        return sqrt(total_x * total_x + total_y * total_y)

    def try_attach(self, child: SupportAnchor, revertible_index: int | None = None) -> SupportAnchor | None:
        """Find the best trunk for this (output-space) child and return the
        reanchored tree anchor, or None if no trunk works. Candidates are
        scored by distance plus resulting net moment, so merges that balance
        an existing one-sided load are preferred over merely-near ones. When
        revertible_index is given, the attachment is recorded so the material
        audit can undo it if the trunk ends up a net loss."""
        if not self.enabled:
            return None
        child_joint = _joint_layer(child)
        joint_x, joint_y = _joint_xy(child)
        child_a: SupportAnchor | None = None
        key = self._grid_key(joint_x, joint_y)
        best: tuple[int, int, float, float] | None = None
        best_cost: float | None = None
        for cell_x in (key[0] - 1, key[0], key[0] + 1):
            for cell_y in (key[1] - 1, key[1], key[1] + 1):
                for parent_index in self.grid.get((cell_x, cell_y), ()):
                    trunk = self.anchors[parent_index]
                    base_x, base_y = _base_xy(trunk)
                    dx_mm = (joint_x - base_x) * self.config.pixel_size_x_mm
                    dy_mm = (joint_y - base_y) * self.config.pixel_size_y_mm
                    d2 = dx_mm * dx_mm + dy_mm * dy_mm
                    if d2 > self.reach2:
                        continue
                    ex = (child.x - base_x) * self.config.pixel_size_x_mm
                    ey = (child.y - base_y) * self.config.pixel_size_y_mm
                    tips = 2 + len(self.junctions.get(parent_index, ()))
                    net_moment = self._moment_sum(parent_index, ex, ey)
                    cost = sqrt(d2) + net_moment
                    if best_cost is not None and cost >= best_cost:
                        continue
                    if not _trunk_capacity_ok(
                        tips, net_moment, self.support.post_radius_mm, self.support.tree_stress_factor
                    ):
                        continue
                    # Material rule: a merge saves one post-area over the
                    # child's junction span and thickens the trunk over (at
                    # most) the same span, so it pays iff the base area grows
                    # by less than one post-area. The first child gets slack —
                    # later children on the far side cancel its moment and
                    # recover the cost — but a trunk must never keep growing
                    # one-sided at a loss.
                    old_scale = _trunk_radius_scale(
                        tips - 1,
                        self._moment_sum(parent_index, 0.0, 0.0),
                        self.support.post_radius_mm,
                        self.support.tree_stress_factor,
                    )
                    new_scale = _trunk_radius_scale(
                        tips, net_moment, self.support.post_radius_mm, self.support.tree_stress_factor
                    )
                    area_growth = new_scale * new_scale - old_scale * old_scale
                    if area_growth > (2.5 if tips == 2 else 1.0) + 1e-9:
                        continue
                    rise_layers = max(1, int(ceil(sqrt(d2) / self.tan_max / self.config.layer_height_mm)))
                    junction_layer = min(child_joint - rise_layers, _joint_layer(trunk))
                    if junction_layer < self.min_junction_layer:
                        continue
                    if child_a is None:
                        child_a = _scale_anchor_to_output(child, self.config, self.analysis_config)
                    if self._child_collides(child_a, parent_index, junction_layer):
                        continue
                    if self._trunk_collides_thickened(parent_index, tips, net_moment):
                        continue
                    best = (parent_index, junction_layer, ex, ey)
                    best_cost = cost
        if best is None:
            return None
        parent_index, junction_layer, ex, ey = best
        entry = (junction_layer, ex, ey)
        self.junctions.setdefault(parent_index, []).append(entry)
        if revertible_index is not None:
            self.children[revertible_index] = (parent_index, entry)
        tips = 1 + len(self.junctions[parent_index])
        scale = _trunk_radius_scale(
            tips,
            self._moment_sum(parent_index, 0.0, 0.0),
            self.support.post_radius_mm,
            self.support.tree_stress_factor,
        )
        self._checked_extra_px[parent_index] = max(
            self._checked_extra_px.get(parent_index, 0), self._extra_px(scale)
        )
        trunk_base_x, trunk_base_y = _base_xy(self.anchors[parent_index])
        return replace(
            child,
            base_x=trunk_base_x,
            base_y=trunk_base_y,
            base_layer=junction_layer,
            kind="tree",
        )

    def _extra_px(self, scale: float) -> int:
        extra_mm = self.support.post_radius_mm * max(0.0, scale - 1.0)
        if extra_mm <= 1e-9:
            return 0
        return int(ceil(extra_mm / self._analysis_pixel_mm))

    def _child_collides(self, child_a: SupportAnchor, parent_index: int, junction_layer: int) -> bool:
        trunk_a = self._trunk_analysis(parent_index)
        trunk_base = _base_xy(trunk_a)
        child_joint_xy = _joint_xy(child_a)
        synthetic = SupportAnchor(
            x=child_a.x,
            y=child_a.y,
            top_layer=child_a.top_layer,
            base_x=trunk_base[0],
            base_y=trunk_base[1],
            base_layer=junction_layer,
            joint_x=child_joint_xy[0],
            joint_y=child_joint_xy[1],
            joint_layer=child_a.joint_layer,
            tip_type=child_a.tip_type,
            kind="tree",
            role=child_a.role,
        )
        return _route_collides(
            self.occupied_layers,
            self.analysis_config.resolution_x,
            self.analysis_config.resolution_y,
            synthetic,
            self.collision_radius,
        )

    def _trunk_collides_thickened(self, parent_index: int, tips: int, net_moment: float) -> bool:
        """The trunk was collision-checked at its plain radius when routed;
        accepting more load thickens it, which can clip geometry the thin
        shaft cleared. Re-check whenever the pixel radius would grow."""
        scale = _trunk_radius_scale(
            tips, net_moment, self.support.post_radius_mm, self.support.tree_stress_factor
        )
        extra_px = self._extra_px(scale)
        if extra_px <= self._checked_extra_px.get(parent_index, 0):
            return False
        return _route_collides(
            self.occupied_layers,
            self.analysis_config.resolution_x,
            self.analysis_config.resolution_y,
            self._trunk_analysis(parent_index),
            self.collision_radius + extra_px,
        )

    def _added_area_layers(self, parent_index: int, junctions: list[tuple[int, float, float]]) -> float:
        """Extra trunk shaft material versus a plain post, in units of one
        post-area x layer, computed per layer from the cumulative load and net
        moment above it (the same quantities the stamper tapers by)."""
        trunk_joint = _joint_layer(self.anchors[parent_index])
        total = 0.0
        for layer in range(0, trunk_joint + 1):
            tips = 1
            ex = 0.0
            ey = 0.0
            for junction_layer, jx, jy in junctions:
                if junction_layer > layer:
                    tips += 1
                    ex += jx
                    ey += jy
            if tips <= 1:
                continue
            scale = _trunk_radius_scale(
                tips, sqrt(ex * ex + ey * ey), self.support.post_radius_mm, self.support.tree_stress_factor
            )
            total += scale * scale - 1.0
        return total

    def audit_material(self) -> None:
        """Undo merges that ended up a net material loss. Per-child greedy
        acceptance gambles that later children will balance a trunk's moment;
        when that never happened, the trunk carries expensive thickness for
        little pillar savings. Reverting a merge is safe: these children's
        straight bed routes were collision-checked when they were first
        planned. Fallback children (no straight alternative) never revert."""
        by_parent: dict[int, list[int]] = {}
        for child_index, (parent_index, _entry) in self.children.items():
            by_parent.setdefault(parent_index, []).append(child_index)
        for parent_index, child_indices in sorted(by_parent.items()):
            while True:
                junctions = self.junctions.get(parent_index, [])
                revertible = [index for index in child_indices if index in self.children]
                if not revertible:
                    break
                added = self._added_area_layers(parent_index, junctions)
                saved = sum(float(self.children[index][1][0]) for index in revertible)
                net = added - saved
                if net <= 1e-9:
                    break
                best_index = None
                best_net = net
                for index in revertible:
                    entry = self.children[index][1]
                    trial = list(junctions)
                    trial.remove(entry)
                    trial_net = self._added_area_layers(parent_index, trial) - (saved - float(entry[0]))
                    if trial_net < best_net - 1e-9:
                        best_net = trial_net
                        best_index = index
                if best_index is None:
                    break
                entry = self.children.pop(best_index)[1]
                junctions.remove(entry)
                child = self.anchors[best_index]
                self.anchors[best_index] = replace(
                    child,
                    base_x=child.joint_x,
                    base_y=child.joint_y,
                    base_layer=0,
                    kind="bed",
                )

    def apply_junctions(self) -> None:
        """Write accumulated junction data onto the trunk anchors in place.
        Idempotent: junction lists are the source of truth, so re-applying
        after later attaches just refreshes the same anchors."""
        for parent_index, junctions in self.junctions.items():
            ordered = tuple(sorted(junctions))
            self.anchors[parent_index] = replace(
                self.anchors[parent_index],
                junctions=ordered,
                load=1 + len(ordered),
            )


def _merge_tree_supports(builder: _TreeBuilder) -> None:
    """Merge nearby bed-routed shafts into shared trunks, in place on
    builder.anchors. Processing lowest joints first makes the shafts closest
    to the bed become the trunks that higher contacts lean onto. Manual and
    painted supports never lean (the user chose those spots) but may serve as
    trunks."""
    anchors = builder.anchors
    if not builder.enabled or len(anchors) < 2:
        return
    eligible = [
        index
        for index, anchor in enumerate(anchors)
        if anchor.kind == "bed" and anchor.base_layer == 0
    ]
    if not eligible:
        return
    # Centroid-first ordering: for equal joint heights, the most central
    # contact seeds the trunk, so children spread around it and their moment
    # contributions cancel (which is what keeps trunks thin).
    mean_x = sum(anchors[index].x for index in eligible) / len(eligible)
    mean_y = sum(anchors[index].y for index in eligible) / len(eligible)
    order = sorted(
        eligible,
        key=lambda index: (
            _joint_layer(anchors[index]),
            (anchors[index].x - mean_x) ** 2 + (anchors[index].y - mean_y) ** 2,
            anchors[index].x,
            anchors[index].y,
        ),
    )
    for index in order:
        child = anchors[index]
        if child.role in {"manual", "painted"}:
            builder.register_parent(index)
            continue
        attached = builder.try_attach(child, revertible_index=index)
        if attached is None:
            builder.register_parent(index)
        else:
            anchors[index] = attached
    builder.audit_material()
    builder.apply_junctions()


def _attach_failed_contacts(
    builder: _TreeBuilder,
    contacts: list[_FailedContact],
    placed_points: "_PlacedPointIndex",
    on_anchor: Callable[[SupportAnchor], None] | None,
) -> list[_FailedContact]:
    """Second chance for contacts whose straight route hit the model: lean
    them onto an existing trunk. Straight-first ordering means trunks are laid
    down before this runs, so a contact that is only reachable through a tree
    still gets its support. Returns the contacts that still cannot route."""
    if not builder.enabled or not contacts:
        return contacts
    analysis_config = builder.analysis_config
    config = builder.config
    support = builder.support
    remaining: list[_FailedContact] = []
    for contact in contacts:
        route_a = _build_route(
            analysis_config,
            support,
            contact.x,
            contact.y,
            contact.layer_index,
            contact.normal,
            contact.x,
            contact.y,
            0,
            "bed",
            contact.role,
        )
        child = _scale_anchor_to_output(route_a, analysis_config, config)
        if contact.spacing_mm > 0 and placed_points.too_close(child.x, child.y, contact.spacing_mm):
            # A neighbouring support landed here in the meantime; the contact
            # would have been thinned away anyway, so it is not a failure.
            continue
        attached = builder.try_attach(child)
        if attached is None:
            remaining.append(contact)
            continue
        builder.anchors.append(attached)
        placed_points.add(attached.x, attached.y)
        if on_anchor is not None:
            on_anchor(attached)
    builder.apply_junctions()
    return remaining


def _minima_contact_candidates(
    triangles: tuple[Triangle, ...],
    config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
) -> dict[int, list[_MeshCandidate]]:
    """Find local z-minima of the mesh: the points that print first in their
    neighbourhood and therefore need a support tip exactly there, before the
    raster island sweep can even see them (it detects an island only once it
    spans an analysis pixel, one or more layers late and off-centre).

    Strict minima (a downward tip, lower than every welded neighbour) thin at a
    tighter spacing because nothing else can hold that first layer. Plateau
    minima (the boundary of a flat bottom: no lower neighbour, some equal, some
    higher) use the normal spacing — the island sweep covers their interior."""
    if layer_count <= 0 or not triangles:
        return {}
    tol = 1e-4

    def key_of(point: Point3) -> tuple[float, float, float]:
        return (round(point[0], 5), round(point[1], 5), round(point[2], 5))

    points: dict[tuple[float, float, float], Point3] = {}
    neighbors: dict[tuple[float, float, float], set[tuple[float, float, float]]] = {}
    for triangle in triangles:
        keys = tuple(key_of(point) for point in triangle)
        for index in range(3):
            points.setdefault(keys[index], triangle[index])
            other = keys[(index + 1) % 3]
            if keys[index] == other:
                continue
            neighbors.setdefault(keys[index], set()).add(other)
            neighbors.setdefault(other, set()).add(keys[index])

    tip_spacing = max(support.post_radius_mm * 3.0, support.support_spacing_mm / 2.0)
    out: dict[int, list[_MeshCandidate]] = {}
    for key, point in points.items():
        near = neighbors.get(key)
        if not near:
            continue
        z = key[2]
        lower = False
        higher = False
        strict = True
        for other in near:
            if other[2] < z - tol:
                lower = True
                break
            if other[2] > z + tol:
                higher = True
            else:
                strict = False
        if lower or not higher:
            continue
        layer_index = int(round(z / config.layer_height_mm - 0.5))
        # Minima on (or below) the first layer sit on the build plate already.
        if layer_index <= 0 or layer_index >= layer_count:
            continue
        x = min(max(0, int(round(point[0] / config.pixel_size_x_mm - 0.5))), config.resolution_x - 1)
        y = min(max(0, int(round(point[1] / config.pixel_size_y_mm - 0.5))), config.resolution_y - 1)
        spacing = tip_spacing if strict else support.support_spacing_mm
        out.setdefault(layer_index, []).append(
            _MeshCandidate(x, y, layer_index, spacing, "minima", point)
        )
    # Strict tips route first (smaller spacing sorts first), then stable x/y
    # order keeps plans deterministic.
    for candidates in out.values():
        candidates.sort(key=lambda c: (c.spacing_mm, c.point_mm[0], c.point_mm[1]))
    return out


def _analysis_scaled_plan(
    plan: SupportPlan,
    config: PrintConfig,
    analysis_config: PrintConfig,
    support: SupportConfig,
) -> SupportPlan:
    """Rescale an output-resolution plan into the analysis raster space so the
    verification pass can stamp supports onto the analysis-resolution layers.
    The raft masks are dropped: everything on the first layer is treated as
    plate-supported anyway, so the raft cannot change the island result."""
    anchors = tuple(_scale_anchor_to_output(anchor, config, analysis_config) for anchor in plan.anchors)
    analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    brace_radius_px = mm_to_px(support.brace_radius_mm, analysis_pixel_mm)
    braces = []
    for brace in plan.braces:
        x0, y0 = _scale_point_to_output(brace.x0, brace.y0, config, analysis_config)
        x1, y1 = _scale_point_to_output(brace.x1, brace.y1, config, analysis_config)
        braces.append(SupportBrace(x0, y0, x1, y1, brace.start_layer, brace.end_layer, brace_radius_px))
    return build_support_plan(anchors, tuple(braces), analysis_config, support)


def _unsupported_islands(
    plan: SupportPlan,
    occupied_by_index: dict[int, _OccupiedLayer],
    config: PrintConfig,
    analysis_config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
    min_area_px: int,
    lookback_layers: int,
) -> list[tuple[Component, int]]:
    """Closed-loop verification: stamp the planned supports into copies of the
    analysis layers and re-run island detection on what will actually print.
    A region is an island when no pixel of its connected component sits above
    cured material (model or support) within the overhang allowance."""
    analysis_plan = _analysis_scaled_plan(plan, config, analysis_config, support)
    pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    width = analysis_config.resolution_x
    height = analysis_config.resolution_y
    empty = LayerRaster(width, height)
    history: deque[LayerRaster] = deque(maxlen=lookback_layers)
    islands: list[tuple[Component, int]] = []
    tip_grace_radius = max(1, analysis_plan.tip_radius_px)
    for layer_index in range(layer_count):
        occupied = occupied_by_index.get(layer_index)
        current = occupied.raster.copy() if occupied is not None else LayerRaster(width, height)
        apply_supports(current, layer_index, analysis_plan)
        # A tip also covers material that appears within the lookback window
        # above it: a feature narrower than an analysis pixel (e.g. a spire
        # growing off its supported apex) rasterises a few layers late here even
        # though it prints continuously at full output resolution. Without this
        # vertical grace — the mirror of the horizontal dilation allowance —
        # those layers read as islands and attract stacked rescue supports.
        for anchor in analysis_plan.anchors:
            if anchor.top_layer < layer_index <= anchor.top_layer + lookback_layers:
                current.add_disk(anchor.x, anchor.y, tip_grace_radius, 255)
        # The first layer sits on the build plate; everything is supported.
        if layer_index == 0 or current.count_on() == 0:
            history.append(current)
            continue
        base_layer = history[0] if history else empty
        previous = history[-1] if history else empty
        overhang_px = _overhang_allowance_px(analysis_config, support, pixel_mm, max(1, len(history)))
        support_mask = dilate_mask(base_layer, overhang_px)
        unsupported = current.unsupported_mask(support_mask)
        for component in current.connected_components(unsupported, min_area_px):
            if _component_attached(component, current, support_mask):
                continue
            # Diagonal structures (braces, steep tree shafts) print by direct
            # layer-to-layer disk overlap even when they outrun the model's
            # overhang allowance; anything overlapping or bordering cured
            # material in the layer immediately below is not an island.
            if _component_continuous_below(component, previous):
                continue
            islands.append((component, layer_index))
        history.append(current)
    return islands


def _component_attached(component: Component, current: LayerRaster, support_mask: bytearray) -> bool:
    """An unsupported blob is still fine when it merges laterally with cured
    material in the same layer (the layer prints as one connected region). Only
    blobs with no supported neighbour anywhere on their boundary are islands."""
    width = current.width
    height = current.height
    pixels = current.pixels
    for index in component.pixels:
        x = index % width
        y = index // width
        if x > 0 and pixels[index - 1] and support_mask[index - 1]:
            return True
        if x < width - 1 and pixels[index + 1] and support_mask[index + 1]:
            return True
        if y > 0 and pixels[index - width] and support_mask[index - width]:
            return True
        if y < height - 1 and pixels[index + width] and support_mask[index + width]:
            return True
    return False


def _component_continuous_below(component: Component, previous: LayerRaster) -> bool:
    width = previous.width
    height = previous.height
    pixels = previous.pixels
    for index in component.pixels:
        if pixels[index]:
            return True
        x = index % width
        y = index // width
        if x > 0 and pixels[index - 1]:
            return True
        if x < width - 1 and pixels[index + 1]:
            return True
        if y > 0 and pixels[index - width]:
            return True
        if y < height - 1 and pixels[index + width]:
            return True
    return False


def _rescue_islands(
    islands: list[tuple[Component, int]],
    occupied_layers: list[_OccupiedLayer],
    occupied_by_index: dict[int, _OccupiedLayer],
    analysis_config: PrintConfig,
    config: PrintConfig,
    support: SupportConfig,
    surface_normals: "_SurfaceNormalSampler",
    collision_radius: int,
    placed_points: "_PlacedPointIndex",
    exclude_zones: tuple[PaintZone, ...],
    on_anchor: Callable[[SupportAnchor], None] | None,
    attempted: set[tuple[int, int, int]],
) -> tuple[list[SupportAnchor], list[_FailedContact]]:
    """Route supports onto islands the verification pass found. The island
    exists because normal planning dropped or failed its supports, so the first
    rescue point per island bypasses the global spacing check; further points
    within a large island still thin out normally. Routing is deterministic
    against the fixed model layers, so candidates already attempted in an
    earlier pass are skipped instead of failing (and being counted) again.
    Candidates that cannot route straight are returned for the tree fallback."""
    width = analysis_config.resolution_x
    pixel_x = analysis_config.pixel_size_x_mm
    pixel_y = analysis_config.pixel_size_y_mm
    layer_height = analysis_config.layer_height_mm
    empty = LayerRaster(analysis_config.resolution_x, analysis_config.resolution_y)
    rescued: list[SupportAnchor] = []
    failed: list[_FailedContact] = []
    for component, layer_index in islands:
        occupied = occupied_by_index.get(layer_index)
        if occupied is None:
            continue
        model = occupied.raster
        below = occupied_by_index.get(layer_index - 1)
        below_raster = below.raster if below is not None else empty
        routed_any = False
        for candidate in _anchor_candidates(component, analysis_config, support):
            x, y = candidate.x, candidate.y
            # The island blob can include stamped support pixels; only contact
            # actual model surface.
            if not model.pixels[y * width + x]:
                continue
            key = (x, y, layer_index)
            if key in attempted:
                continue
            attempted.add(key)
            out_x, out_y = _scale_point_to_output(x, y, analysis_config, config)
            if routed_any and placed_points.too_close(out_x, out_y, candidate.spacing_mm):
                continue
            contact_point = (
                (x + 0.5) * pixel_x,
                (y + 0.5) * pixel_y,
                (layer_index + 0.5) * layer_height,
            )
            if exclude_zones and _in_paint_zones(contact_point, exclude_zones):
                continue
            fallback_normal = _estimate_surface_normal(model, below_raster, analysis_config, x, y)
            normal = surface_normals.normal_at_contact(contact_point, fallback_normal)
            route = _find_support_route(
                occupied_layers,
                analysis_config,
                support,
                x,
                y,
                layer_index,
                normal,
                collision_radius,
                "rescue",
            )
            if route is None:
                # Spacing 0: an island needs a support even next to others.
                failed.append(_FailedContact(x, y, layer_index, normal, "rescue", 0.0))
                continue
            out_anchor = _scale_anchor_to_output(route, analysis_config, config)
            placed_points.add(out_anchor.x, out_anchor.y)
            rescued.append(out_anchor)
            routed_any = True
            if on_anchor is not None:
                on_anchor(out_anchor)
    return rescued, failed


@dataclass
class _HoleComponent:
    """An enclosed background region of one layer (a cavity cross-section)."""

    area_px: int
    cx: float
    cy: float
    min_x: int
    min_y: int
    max_x: int
    max_y: int


@dataclass
class _CupChain:
    start_layer: int
    mouth: _HoleComponent
    last: _HoleComponent
    volume_px_layers: float
    open_bottom: bool


def _enclosed_hole_components(raster: LayerRaster) -> list[_HoleComponent]:
    """Background regions not reachable from the layer border, found with a
    span-based union-find (one pass over the rows, no per-pixel flood fill)."""
    width = raster.width
    height = raster.height
    pixels = raster.pixels
    parent: list[int] = [0]  # id 0 = the border-connected background

    def find(node: int) -> int:
        root = node
        while parent[root] != root:
            root = parent[root]
        while parent[node] != root:
            parent[node], node = root, parent[node]
        return root

    def union(a: int, b: int) -> None:
        root_a, root_b = find(a), find(b)
        if root_a != root_b:
            parent[max(root_a, root_b)] = min(root_a, root_b)

    all_spans: list[tuple[int, int, int, int]] = []  # (y, x0, x1, id)
    previous_row: list[tuple[int, int, int]] = []
    for y in range(height):
        row_start = y * width
        row_end = row_start + width
        row_spans: list[tuple[int, int, int]] = []
        x = 0
        while x < width:
            if pixels[row_start + x]:
                nxt = pixels.find(0, row_start + x, row_end)
                if nxt == -1:
                    break
                x = nxt - row_start
                continue
            end = pixels.find(255, row_start + x, row_end)
            x1 = (end - row_start - 1) if end != -1 else width - 1
            span_id = len(parent)
            parent.append(span_id)
            if x == 0 or x1 == width - 1 or y == 0 or y == height - 1:
                union(span_id, 0)
            row_spans.append((x, x1, span_id))
            all_spans.append((y, x, x1, span_id))
            x = x1 + 1
        # Union with overlapping off-spans of the previous row (4-connectivity).
        prev_index = 0
        for x0, x1, span_id in row_spans:
            while prev_index < len(previous_row) and previous_row[prev_index][1] < x0:
                prev_index += 1
            scan = prev_index
            while scan < len(previous_row) and previous_row[scan][0] <= x1:
                union(span_id, previous_row[scan][2])
                scan += 1
        previous_row = row_spans

    stats: dict[int, _HoleComponent] = {}
    for y, x0, x1, span_id in all_spans:
        root = find(span_id)
        if root == 0:
            continue
        length = x1 - x0 + 1
        mid = (x0 + x1) / 2.0
        entry = stats.get(root)
        if entry is None:
            stats[root] = _HoleComponent(length, mid * length, y * length, x0, y, x1, y)
        else:
            entry.area_px += length
            entry.cx += mid * length
            entry.cy += y * length
            entry.min_x = min(entry.min_x, x0)
            entry.max_x = max(entry.max_x, x1)
            entry.max_y = y
    holes = []
    for entry in stats.values():
        entry.cx /= entry.area_px
        entry.cy /= entry.area_px
        holes.append(entry)
    return holes


def _boxes_overlap(a: _HoleComponent, b: _HoleComponent) -> bool:
    return a.min_x <= b.max_x and b.min_x <= a.max_x and a.min_y <= b.max_y and b.min_y <= a.max_y


def _solid_at(occupied: _OccupiedLayer | None, width: int, cx: float, cy: float) -> bool:
    if occupied is None:
        return False
    x = int(round(cx))
    y = int(round(cy))
    if x < 0 or y < 0 or x >= width or y >= occupied.raster.height:
        return False
    return bool(occupied.raster.pixels[y * width + x])


_CUP_SAMPLE_STEP_MM = 1.0


def _detect_suction_cups(
    occupied_by_index: dict[int, _OccupiedLayer],
    analysis_config: PrintConfig,
    support: SupportConfig,
    layer_count: int,
) -> tuple[SuctionCup, ...]:
    """Find downward-opening cavities that seal at the top. Cavity
    cross-sections (enclosed holes) are chained across layers sampled every
    ~1mm; a chain whose bottom is open (mouth toward the film) and whose hole
    disappears under solid material is a suction cup. Chains that stay open to
    the model's top are vented and ignored, as are fully enclosed voids (a
    different problem: trapped resin, no film interface)."""
    if not support.cup_detection_enabled or layer_count <= 0:
        return ()
    width = analysis_config.resolution_x
    step_layers = max(1, int(round(_CUP_SAMPLE_STEP_MM / analysis_config.layer_height_mm)))
    step_mm = step_layers * analysis_config.layer_height_mm
    min_area_px = support.cup_min_area_mm2 / analysis_config.pixel_area_mm2
    cups: list[SuctionCup] = []
    active: list[_CupChain] = []

    def emit(chain: _CupChain, end_layer: int) -> None:
        if not chain.open_bottom or chain.mouth.area_px < min_area_px:
            return
        cups.append(
            SuctionCup(
                x_mm=(chain.mouth.cx + 0.5) * analysis_config.pixel_size_x_mm,
                y_mm=(chain.mouth.cy + 0.5) * analysis_config.pixel_size_y_mm,
                z_mm=(chain.start_layer + 0.5) * analysis_config.layer_height_mm,
                mouth_area_mm2=chain.mouth.area_px * analysis_config.pixel_area_mm2,
                height_mm=max(step_mm, (end_layer - chain.start_layer) * analysis_config.layer_height_mm),
                volume_mm3=chain.volume_px_layers * analysis_config.pixel_area_mm2 * analysis_config.layer_height_mm,
            )
        )

    for sample_layer in range(0, layer_count, step_layers):
        occupied = occupied_by_index.get(sample_layer)
        holes = _enclosed_hole_components(occupied.raster) if occupied is not None else []
        consumed = [False] * len(holes)
        survivors: list[_CupChain] = []
        for chain in active:
            match = None
            for index, hole in enumerate(holes):
                if not consumed[index] and _boxes_overlap(chain.last, hole):
                    match = index
                    break
            if match is not None:
                consumed[match] = True
                chain.last = holes[match]
                chain.volume_px_layers += holes[match].area_px * step_layers
                survivors.append(chain)
                continue
            # The hole vanished: capped by solid (a cup) or opened up (vented).
            if _solid_at(occupied, width, chain.last.cx, chain.last.cy):
                emit(chain, sample_layer)
        active = survivors
        below = occupied_by_index.get(sample_layer - step_layers)
        for index, hole in enumerate(holes):
            if consumed[index]:
                continue
            # A new cavity: its mouth is open downward unless solid sits under
            # it (which would make it an enclosed void instead).
            open_bottom = not _solid_at(below, width, hole.cx, hole.cy)
            active.append(
                _CupChain(
                    start_layer=sample_layer,
                    mouth=hole,
                    last=hole,
                    volume_px_layers=hole.area_px * step_layers,
                    open_bottom=open_bottom,
                )
            )
    # Chains still alive at the model top are open upward: vented, not cups.
    return tuple(cups)


def _residual_island(component: Component, layer_index: int, analysis_config: PrintConfig) -> ResidualIsland:
    cx, cy = component.centroid(analysis_config.resolution_x)
    return ResidualIsland(
        x_mm=(cx + 0.5) * analysis_config.pixel_size_x_mm,
        y_mm=(cy + 0.5) * analysis_config.pixel_size_y_mm,
        z_mm=(layer_index + 0.5) * analysis_config.layer_height_mm,
        area_mm2=component.area_px * analysis_config.pixel_area_mm2,
        layer_index=layer_index,
    )


def _find_support_route(
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
    route = _build_route(config, support, top_x, top_y, top_layer, normal, top_x, top_y, 0, "bed", role)
    joint_x, joint_y = _joint_xy(route)
    if 0 <= joint_x < config.resolution_x and 0 <= joint_y < config.resolution_y:
        if not _route_collides(occupied_layers, config.resolution_x, config.resolution_y, route, collision_radius):
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
    occupied_layers: list[_OccupiedLayer],
    analysis_config: PrintConfig,
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
    interval_layers = (
        max(1, int(round(support.brace_interval_mm / config.layer_height_mm)))
        if support.brace_interval_mm > 0
        else 0
    )
    max_distance_px = max(
        1,
        int(round(support.brace_max_distance_mm / min(config.pixel_size_x_mm, config.pixel_size_y_mm))),
    )
    min_distance_px = max(1, radius_px * 4)
    # Collision checks run against the analysis-resolution layers that were
    # already rendered for anchor planning; rendering (and caching) layers at
    # the full printer resolution here can eat gigabytes on large machines.
    analysis_pixel_mm = min(analysis_config.pixel_size_x_mm, analysis_config.pixel_size_y_mm)
    collision_radius_px = mm_to_px(support.brace_radius_mm + support.collision_clearance_mm, analysis_pixel_mm)
    occupied_by_index = {occupied.layer_index: occupied for occupied in occupied_layers}

    centers = [_support_center(anchor, min(start_layer, anchor.top_layer)) for anchor in brace_anchors]
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
            # Tall supports get a brace rung at every interval level, not just
            # the first one; alternating the diagonal direction per level makes
            # the repeated rungs zig-zag for a stiffer truss.
            pair_top = min(_joint_layer(brace_anchors[i]), _joint_layer(brace_anchors[j]))
            level = 0
            level_start = start_layer
            while level_start <= pair_top:
                brace = _diagonal_brace_between(
                    brace_anchors[i],
                    brace_anchors[j],
                    level_start,
                    layer_count,
                    radius_px,
                    collision_radius_px,
                    occupied_by_index,
                    analysis_config,
                    config,
                    reverse=level % 2 == 1,
                    # Short supports cannot fit the 45-degree diagonal above the
                    # configured start height (it would overshoot their joints),
                    # so let the first rung slide down towards the bed instead
                    # of dropping the brace entirely.
                    min_start_layer=bed_interface_layers if level == 0 else None,
                )
                if brace is not None:
                    braces.append(brace)
                if interval_layers <= 0:
                    break
                level += 1
                level_start = start_layer + level * interval_layers
    return tuple(braces)


def _diagonal_brace_between(
    first: SupportAnchor,
    second: SupportAnchor,
    start_layer: int,
    layer_count: int,
    radius_px: int,
    collision_radius_px: int,
    occupied_by_index: dict[int, _OccupiedLayer],
    analysis_config: PrintConfig,
    config: PrintConfig,
    reverse: bool = False,
    min_start_layer: int | None = None,
) -> SupportBrace | None:
    ordered = ((second, first), (first, second)) if reverse else ((first, second), (second, first))
    for source, target in ordered:
        brace = _make_diagonal_brace(source, target, start_layer, layer_count, radius_px, config, min_start_layer)
        if brace is not None and not _brace_collides_with_model(
            brace, collision_radius_px, occupied_by_index, analysis_config, config
        ):
            return brace
    return None


def _make_diagonal_brace(
    source: SupportAnchor,
    target: SupportAnchor,
    start_layer: int,
    layer_count: int,
    radius_px: int,
    config: PrintConfig,
    min_start_layer: int | None = None,
) -> SupportBrace | None:
    source_joint_layer = _joint_layer(source)
    target_joint_layer = _joint_layer(target)

    x0, y0 = _support_center(source, min(start_layer, source_joint_layer))
    x1, y1 = _support_center(target, min(start_layer, target_joint_layer))
    dx_mm = (x1 - x0) * config.pixel_size_x_mm
    dy_mm = (y1 - y0) * config.pixel_size_y_mm
    horizontal_mm = sqrt(dx_mm * dx_mm + dy_mm * dy_mm)
    if horizontal_mm <= 0:
        return None
    span_layers = max(1, int(round(horizontal_mm / config.layer_height_mm)))
    end_layer = start_layer + span_layers
    limit = min(layer_count - 1, target_joint_layer)
    if end_layer > limit and min_start_layer is not None:
        # The 45-degree diagonal overshoots the pair's joints (typical for
        # lift-height supports on fine layer heights). Slide the rung down as
        # far as the bed interface allows, then flatten its angle to the
        # remaining height — but no shallower than a third of the 45-degree
        # rise (~18 degrees), and never so flat that consecutive layers'
        # stamped disks stop overlapping (at coarse layer heights a flattened
        # rung can step further per layer than its own diameter, printing as a
        # row of disconnected dashes).
        start_layer = max(min_start_layer, limit - span_layers)
        available_layers = limit - start_layer
        horizontal_px = sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
        connect_span_layers = int(ceil(horizontal_px / (2.0 * max(1, radius_px))))
        min_span_layers = max(1, int(ceil(span_layers / 3)), connect_span_layers)
        if available_layers < min_span_layers:
            return None
        span_layers = min(span_layers, available_layers)
        end_layer = start_layer + span_layers
        # Re-anchor the ends on the (possibly slanted) posts at the new layers.
        x0, y0 = _support_center(source, min(start_layer, source_joint_layer))
        x1, y1 = _support_center(target, min(end_layer, target_joint_layer))
    if start_layer > source_joint_layer:
        return None
    if end_layer >= layer_count or end_layer > target_joint_layer:
        return None
    return SupportBrace(x0, y0, x1, y1, start_layer, end_layer, radius_px)


def _brace_collides_with_model(
    brace: SupportBrace,
    radius_px: int,
    occupied_by_index: dict[int, _OccupiedLayer],
    analysis_config: PrintConfig,
    config: PrintConfig,
) -> bool:
    """Check the brace path against the analysis-resolution model layers.

    Brace coordinates are in output pixels; the occupied layers were rendered
    at the (possibly downscaled) analysis resolution, so scale the centre into
    that space before testing. radius_px is already in analysis pixels."""
    scale_x = analysis_config.resolution_x / config.resolution_x
    scale_y = analysis_config.resolution_y / config.resolution_y
    for layer_index in range(max(0, brace.start_layer), brace.end_layer + 1):
        occupied = occupied_by_index.get(layer_index)
        if occupied is None:
            continue
        x, y = _brace_center(brace, layer_index)
        ax = min(max(0, int(round((x + 0.5) * scale_x - 0.5))), analysis_config.resolution_x - 1)
        ay = min(max(0, int(round((y + 0.5) * scale_y - 0.5))), analysis_config.resolution_y - 1)
        if (
            ax + radius_px < occupied.min_x
            or ax - radius_px > occupied.max_x
            or ay + radius_px < occupied.min_y
            or ay - radius_px > occupied.max_y
        ):
            continue
        if _disk_collides(occupied.raster.pixels, analysis_config.resolution_x, analysis_config.resolution_y, ax, ay, radius_px):
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
        load=anchor.load,
        junctions=anchor.junctions,
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


def _post_radius_px(anchor: SupportAnchor, layer_index: int, plan: SupportPlan) -> int:
    if not anchor.junctions:
        return plan.post_radius_px
    # Trunks taper with the cumulative load above each layer: a child's force
    # enters at its junction and flows down, so only layers below the junction
    # carry it (and its moment contribution).
    tips = 1
    ex = 0.0
    ey = 0.0
    for junction_layer, offset_x, offset_y in anchor.junctions:
        if junction_layer > layer_index:
            tips += 1
            ex += offset_x
            ey += offset_y
    if tips <= 1:
        return plan.post_radius_px
    scale = _trunk_radius_scale(tips, sqrt(ex * ex + ey * ey), plan.post_radius_mm, plan.tree_stress_factor)
    return max(1, int(round(plan.post_radius_px * scale)))


def _support_radius_at_layer(anchor: SupportAnchor, layer_index: int, plan: SupportPlan) -> int:
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
    if anchor.kind == "enforcer" and layer_index == anchor.base_layer:
        return plan.tip_radius_px
    if layer_index <= joint_layer or anchor.top_layer <= joint_layer:
        return _post_radius_px(anchor, layer_index, plan)

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


def _peel_density_boost(area_mm2: float, support: SupportConfig) -> float:
    """Spacing divisor for a region needing support. Peel force scales with
    the region's area and the cured plate's deflection between tips scales
    with span^4, so large flat regions need superlinearly more tips: at the
    reference area the tip count doubles."""
    if not support.peel_density_enabled or area_mm2 <= 0:
        return 1.0
    return min(support.peel_max_boost, sqrt(1.0 + area_mm2 / support.peel_area_ref_mm2))


def _anchor_candidates(
    component: Component,
    config: PrintConfig,
    support: SupportConfig,
) -> list[_AnchorCandidate]:
    cx, cy = component.centroid(config.resolution_x)
    boost = _peel_density_boost(component.area_px * config.pixel_area_mm2, support)
    spacing_mm = support.support_spacing_mm / boost
    primary_spacing_mm = spacing_mm
    primary_enabled = support.primary_supports_enabled and support.primary_max_extra_per_island > 0
    if primary_enabled:
        primary_spacing_mm = max(
            support.post_radius_mm * 3.0,
            spacing_mm / support.primary_density_multiplier,
        )

    candidates: list[_AnchorCandidate] = []

    def append_candidate(x: int, y: int, spacing_mm: float, role: str) -> None:
        x = min(max(0, int(x)), config.resolution_x - 1)
        y = min(max(0, int(y)), config.resolution_y - 1)
        for existing in candidates:
            if existing.x == x and existing.y == y:
                return
        candidates.append(_AnchorCandidate(x, y, spacing_mm, role))

    append_candidate(round(cx), round(cy), primary_spacing_mm if primary_enabled else spacing_mm, "primary")

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

    stride_x = max(1, int(round(spacing_mm / config.pixel_size_x_mm)))
    stride_y = max(1, int(round(spacing_mm / config.pixel_size_y_mm)))
    buckets: dict[tuple[int, int], int] = {}
    for index in component.pixels:
        x = index % config.resolution_x
        y = index // config.resolution_x
        bucket = ((x - component.min_x) // stride_x, (y - component.min_y) // stride_y)
        buckets.setdefault(bucket, index)
        if len(buckets) >= support.max_supports_per_island:
            break

    for index in buckets.values():
        append_candidate(index % config.resolution_x, index // config.resolution_x, spacing_mm, "secondary")

    return candidates[: support.max_supports_per_island + support.primary_max_extra_per_island]


class _PlacedPointIndex:
    def __init__(self, config: PrintConfig) -> None:
        self.config = config
        self.cell_size_mm = max(1.0, min(config.size_x_mm, config.size_y_mm) / 48.0)
        self.cells: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add(self, x: int, y: int) -> None:
        self.cells.setdefault(self._key(x, y), []).append((x, y))

    def too_close(self, x: int, y: int, spacing_mm: float) -> bool:
        min_distance2 = spacing_mm * spacing_mm
        radius = max(1, int(ceil(spacing_mm / self.cell_size_mm)))
        cell_x, cell_y = self._key(x, y)
        for ix in range(cell_x - radius, cell_x + radius + 1):
            for iy in range(cell_y - radius, cell_y + radius + 1):
                for other_x, other_y in self.cells.get((ix, iy), ()):
                    dx_mm = (x - other_x) * self.config.pixel_size_x_mm
                    dy_mm = (y - other_y) * self.config.pixel_size_y_mm
                    if dx_mm * dx_mm + dy_mm * dy_mm < min_distance2:
                        return True
        return False

    def _key(self, x: int, y: int) -> tuple[int, int]:
        return (
            int(floor((x * self.config.pixel_size_x_mm) / self.cell_size_mm)),
            int(floor((y * self.config.pixel_size_y_mm) / self.cell_size_mm)),
        )


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
