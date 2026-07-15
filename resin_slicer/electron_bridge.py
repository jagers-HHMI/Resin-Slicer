from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .cad_slicing import CadSliceModel
from .config import PROFILES, PrintConfig, SupportConfig, profile
from .errors import ConfigError, SlicerError
from .mesh import Mesh, load_mesh
from .pipeline import SliceJob, slice_to_file
from .raster import LayerRaster, dilate_mask, mm_to_px
from .slicing import prepare_mesh
from .supports import (
    PaintZone,
    SupportAnchor,
    SupportBrace,
    SupportPlan,
    SupportReport,
    _add_projected_triangle,
    _analysis_config,
    anchor_trunk_scale,
    build_support_plan,
    plan_supports_verified,
)
from .transform import MeshTransform, apply_transform


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="JSON bridge for the Electron UI")
    parser.add_argument("command", choices=["profiles", "preview", "slice"])
    args = parser.parse_args(argv)
    try:
        if args.command == "profiles":
            _write_json({"type": "profiles", "profiles": {name: asdict(cfg) for name, cfg in PROFILES.items()}})
        elif args.command == "preview":
            _preview(_read_json())
        else:
            _slice(_read_json())
    except Exception as exc:
        _write_json({"type": "error", "message": str(exc)})
        return 1
    return 0


def _read_json() -> dict[str, Any]:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        raise SlicerError(f"invalid JSON request: {exc}") from exc


def _write_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def _preview(request: dict[str, Any]) -> None:
    config = _config_from_request(request)
    support = _support_from_request(request)
    transform = _transform_from_request(request)
    mesh = _mesh_from_request(request)
    has_model_entries = bool(request.get("models"))
    if not has_model_entries:
        mesh = apply_transform(
            mesh,
            MeshTransform(
                rotate_x_deg=transform.rotate_x_deg,
                rotate_y_deg=transform.rotate_y_deg,
                rotate_z_deg=transform.rotate_z_deg,
                scale=transform.scale,
            ),
        )
    model_lift = support.model_lift_mm if support.enabled else 0.0
    prepared = prepare_mesh(
        mesh,
        config,
        z_offset_mm=model_lift + transform.translate_z_mm,
        xy_offset_mm=(transform.translate_x_mm, transform.translate_y_mm),
        preserve_coordinates=has_model_entries,
    )
    manual_only = bool(request.get("manualOnly"))
    plan = SupportPlan((), 0, 0, 0, 0.0, 0)
    report = SupportReport()
    if support.enabled:
        def _emit_support(anchor: Any) -> None:
            _write_json({"type": "support", "support": _support_to_json(anchor, None, config, support)})

        plan, report = plan_supports_verified(
            prepared,
            config,
            support,
            prepared.layer_count,
            progress=lambda message: _write_json({"type": "progress", "message": message}),
            include_raft_mask=False,
            on_anchor=_emit_support,
            manual_points=_manual_points_from_request(request),
            manual_only=manual_only,
            paint_zones=_paint_zones_from_request(request),
        )
        # In manual-only mode the model is already lifted (auto supports exist),
        # so never collapse the lift back to zero here.
        if not manual_only and not _preview_support_has_geometry(plan, support) and model_lift > 0:
            model_lift = 0.0
            prepared = prepare_mesh(
                mesh,
                config,
                z_offset_mm=transform.translate_z_mm,
                xy_offset_mm=(transform.translate_x_mm, transform.translate_y_mm),
                preserve_coordinates=has_model_entries,
            )
            plan = SupportPlan((), 0, 0, 0, 0.0, 0)
            report = SupportReport(failed_routes=report.failed_routes)
        # Remember this plan so slicing the same setup does not have to re-run
        # the support analysis in the slice process. Manual-only plans cache
        # under a manual-only key, so a manual-only slice reuses exactly the
        # routed manual/painted supports the user previewed.
        _store_support_plan(_support_plan_cache_key(request), plan)

    bounds = prepared.mesh.bounds()
    _write_json(
        {
            "type": "preview",
            "bed": {"x": config.size_x_mm, "y": config.size_y_mm, "z": config.size_z_mm},
            "bounds": {
                "minX": bounds.min_x,
                "minY": bounds.min_y,
                "minZ": bounds.min_z,
                "maxX": bounds.max_x,
                "maxY": bounds.max_y,
                "maxZ": bounds.max_z,
            },
            "layers": prepared.layer_count,
            "supports": [_support_to_json(anchor, plan, config, support) for anchor in plan.anchors],
            "braces": [_brace_to_json(brace, config) for brace in plan.braces],
            "raft": _raft_preview_to_json(prepared, config, support) if support.enabled else None,
            "supportCount": len(plan.anchors),
            "materialLiftMm": model_lift,
            "report": _report_to_json(report),
        }
    )


def _slice(request: dict[str, Any]) -> None:
    mesh = _mesh_from_request(request)
    transform = _transform_from_request(request)
    has_model_entries = bool(request.get("models"))
    cad_slice_mode = _cad_slice_mode_from_request(request)
    cad_models = _cad_models_from_request(request) if cad_slice_mode == "brep" else ()
    raster_mesh = _mesh_from_request(request, include_step=False) if cad_models else None
    if has_model_entries:
        transform = MeshTransform(
            translate_x_mm=transform.translate_x_mm,
            translate_y_mm=transform.translate_y_mm,
            translate_z_mm=transform.translate_z_mm,
        )
    config = _config_from_request(request)
    support_config = _support_from_request(request)
    preview_scale = 1
    preview_dir = tempfile.mkdtemp(prefix="rspreview_")
    # A plan shipped from the viewport slices verbatim (what you see is what
    # you print); without one, fall back to the cached previewed plan or a
    # fresh analysis.
    preview_plan = _plan_from_preview_request(request, config, support_config)
    result = slice_to_file(
        SliceJob(
            mesh=mesh,
            print_config=config,
            support_config=support_config,
            transform=transform,
            preserve_coordinates=has_model_entries,
            raster_mesh=raster_mesh,
            cad_models=cad_models,
            cad_slice_mode=cad_slice_mode,
            manual_support_points=_manual_points_from_request(request),
            support_paint=_paint_zones_from_request(request),
            manual_support_only=bool(request.get("manualOnly")),
        ),
        request["outputPath"],
        request.get("format", "goo"),
        progress=lambda message: _write_json({"type": "progress", "message": message}),
        layer_workers=_layer_workers_from_request(request),
        preview_dir=preview_dir,
        preview_scale=preview_scale,
        precomputed_support_plan=preview_plan if preview_plan is not None else _load_support_plan(_support_plan_cache_key(request)),
    )
    _write_json(
        {
            "type": "done",
            "outputPath": str(result.output_path),
            "layers": result.layer_count,
            "supports": result.support_count,
            "materialMl": result.material_ml,
            "previewDir": preview_dir,
            "previewLayerCount": result.layer_count,
            "report": _report_to_json(result.support_report) if result.support_report is not None else None,
        }
    )


def _report_to_json(report: SupportReport) -> dict[str, Any]:
    islands = report.residual_islands
    return {
        "failedRoutes": report.failed_routes,
        "rescueCount": report.rescue_count,
        "verified": report.verified,
        "residualIslandCount": len(islands),
        # Cap the payloads; the counts are always the full totals.
        "residualIslands": [
            {
                "x": round(island.x_mm, 3),
                "y": round(island.y_mm, 3),
                "z": round(island.z_mm, 3),
                "areaMm2": round(island.area_mm2, 3),
                "layer": island.layer_index,
            }
            for island in islands[:200]
        ],
        "suctionCupCount": len(report.suction_cups),
        "suctionCups": [
            {
                "x": round(cup.x_mm, 3),
                "y": round(cup.y_mm, 3),
                "z": round(cup.z_mm, 3),
                "mouthAreaMm2": round(cup.mouth_area_mm2, 2),
                "heightMm": round(cup.height_mm, 2),
                "volumeMl": round(cup.volume_mm3 / 1000.0, 3),
            }
            for cup in report.suction_cups[:50]
        ],
    }


def _mesh_from_request(request: dict[str, Any], *, include_step: bool = True) -> Mesh | None:
    models = request.get("models")
    if models:
        triangles = []
        for model in models:
            path = model.get("inputPath") or model.get("path")
            if not path:
                raise SlicerError("model entry is missing inputPath")
            if not include_step and _is_step_path(path):
                continue
            mesh = load_mesh(path)
            triangles.extend(apply_transform(mesh, _model_transform(model)).triangles)
        if not triangles:
            if not include_step:
                return None
            raise SlicerError("no model triangles were loaded")
        return Mesh(tuple(triangles))

    if not include_step and _is_step_path(request.get("inputPath", "")):
        return None
    return load_mesh(request["inputPath"])


def _preview_support_has_geometry(plan: SupportPlan, support: SupportConfig) -> bool:
    return bool(plan.anchors or plan.braces or support.bed_interface in {"raft", "skate"})


# Support-plan cache: the preview and slice commands run in separate Python
# processes, so the plan generated for the viewport is written to a temp file,
# keyed by everything that can change the plan. Slicing reuses it only on an
# exact key match; any settings/model change falls back to a fresh analysis.
# Bump when SupportPlan/SupportAnchor gain fields, so stale pickled plans from
# an older build are discarded instead of unpickling without the new attributes.
_PLAN_CACHE_VERSION = 3
_PLAN_CACHE_MAX_AGE_S = 24 * 60 * 60


def _plan_cache_dir() -> Path:
    return Path(tempfile.gettempdir()) / "resin-slicer-support-plans"


def _model_fingerprint(path: str) -> list[Any]:
    try:
        stat = Path(path).stat()
        return [str(path), stat.st_size, stat.st_mtime_ns]
    except OSError:
        return [str(path), None, None]


def _support_plan_cache_key(request: dict[str, Any]) -> str | None:
    try:
        models = request.get("models") or []
        material = {
            "version": _PLAN_CACHE_VERSION,
            "profile": request.get("profile"),
            "printer": request.get("printer", {}),
            "support": request.get("support", {}),
            "transform": request.get("transform", {}),
            "centerModel": bool(request.get("centerModel", False)),
            "cadSlicingMode": _cad_slice_mode_from_request(request),
            "manualOnly": bool(request.get("manualOnly")),
            "manualPoints": list(_manual_points_from_request(request)),
            "supportPaint": [asdict(zone) for zone in _paint_zones_from_request(request)],
            "models": [
                {
                    "file": _model_fingerprint(model.get("inputPath") or model.get("path") or ""),
                    "transform": model.get("transform", {}),
                }
                for model in models
            ],
            "inputPath": None if models else _model_fingerprint(request.get("inputPath", "")),
        }
        blob = json.dumps(material, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()
    except Exception:
        return None


def _store_support_plan(key: str | None, plan: SupportPlan) -> None:
    if not key:
        return
    try:
        cache_dir = _plan_cache_dir()
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = cache_dir / f"{key}.{os.getpid()}.tmp"
        with open(tmp_path, "wb") as fh:
            pickle.dump({"version": _PLAN_CACHE_VERSION, "plan": plan}, fh)
        os.replace(tmp_path, cache_dir / f"{key}.pkl")
        _prune_support_plans(cache_dir)
    except Exception:
        pass


def _load_support_plan(key: str | None) -> SupportPlan | None:
    if not key:
        return None
    try:
        with open(_plan_cache_dir() / f"{key}.pkl", "rb") as fh:
            payload = pickle.load(fh)
        if payload.get("version") != _PLAN_CACHE_VERSION:
            return None
        plan = payload.get("plan")
        return plan if isinstance(plan, SupportPlan) else None
    except Exception:
        return None


def _prune_support_plans(cache_dir: Path) -> None:
    cutoff = time.time() - _PLAN_CACHE_MAX_AGE_S
    for entry in cache_dir.glob("*.pkl"):
        try:
            if entry.stat().st_mtime < cutoff:
                entry.unlink()
        except OSError:
            continue


def _cad_slice_mode_from_request(request: dict[str, Any]) -> str:
    mode = str(request.get("cadSlicingMode", request.get("cad_slice_mode", "tessellated"))).lower()
    return "brep" if mode in {"brep", "b-rep", "cad", "cad-brep"} else "tessellated"


def _cad_models_from_request(request: dict[str, Any]) -> tuple[CadSliceModel, ...]:
    models = request.get("models")
    if not models:
        return ()
    out: list[CadSliceModel] = []
    for model in models:
        path = model.get("inputPath") or model.get("path")
        if path and _is_step_path(path):
            out.append(CadSliceModel(str(path), _model_transform(model)))
    return tuple(out)


def _is_step_path(path: object) -> bool:
    return str(path or "").lower().endswith((".stp", ".step"))


def _manual_points_from_request(request: dict[str, Any]) -> tuple[tuple[float, float, float], ...]:
    raw = request.get("manualSupports") or ()
    points: list[tuple[float, float, float]] = []
    for entry in raw:
        try:
            if isinstance(entry, dict):
                point = (float(entry["x"]), float(entry["y"]), float(entry["z"]))
            else:
                point = (float(entry[0]), float(entry[1]), float(entry[2]))
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        points.append(point)
    return tuple(points)


def _plan_from_preview_request(request: dict[str, Any], config: PrintConfig, support: SupportConfig) -> SupportPlan | None:
    """Rebuild the exact previewed support plan from the anchors/braces the
    viewport displays (the inverse of _support_to_json/_brace_to_json), so
    slicing produces precisely the supports the user saw."""
    payload = request.get("previewPlan")
    if not isinstance(payload, dict):
        return None
    supports_json = payload.get("supports") or []
    braces_json = payload.get("braces") or []

    def px_x(mm: float) -> int:
        return min(max(0, int(round(mm / config.pixel_size_x_mm - 0.5))), config.resolution_x - 1)

    def px_y(mm: float) -> int:
        return min(max(0, int(round(mm / config.pixel_size_y_mm - 0.5))), config.resolution_y - 1)

    anchors: list[SupportAnchor] = []
    for entry in supports_json:
        try:
            x_mm = float(entry["x"])
            y_mm = float(entry["y"])
            top_layer = int(entry["topLayer"])
            normal = entry.get("normal") or {}
            anchors.append(
                SupportAnchor(
                    x=px_x(x_mm),
                    y=px_y(y_mm),
                    top_layer=top_layer,
                    base_x=px_x(float(entry.get("baseX", x_mm))),
                    base_y=px_y(float(entry.get("baseY", y_mm))),
                    base_layer=int(entry.get("baseLayer", 0)),
                    joint_x=px_x(float(entry.get("jointX", x_mm))),
                    joint_y=px_y(float(entry.get("jointY", y_mm))),
                    joint_layer=int(entry.get("jointLayer", max(0, top_layer - 1))),
                    tip_type=str(entry.get("tipType", support.tip_type)),
                    kind=str(entry.get("kind", "bed")),
                    role=str(entry.get("role", "secondary")),
                    normal_x=float(normal.get("x", 0.0)),
                    normal_y=float(normal.get("y", 0.0)),
                    normal_z=float(normal.get("z", -1.0)),
                    load=max(1, int(entry.get("load", 1))),
                    junctions=tuple(
                        (int(junction[0]), float(junction[1]), float(junction[2]))
                        for junction in entry.get("junctions") or ()
                    ),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue

    output_pixel_mm = min(config.pixel_size_x_mm, config.pixel_size_y_mm)
    braces: list[SupportBrace] = []
    for entry in braces_json:
        try:
            braces.append(
                SupportBrace(
                    x0=px_x(float(entry["x0"])),
                    y0=px_y(float(entry["y0"])),
                    x1=px_x(float(entry["x1"])),
                    y1=px_y(float(entry["y1"])),
                    start_layer=int(entry["startLayer"]),
                    end_layer=int(entry["endLayer"]),
                    radius_px=mm_to_px(float(entry.get("radius", support.brace_radius_mm)), output_pixel_mm),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue

    if not anchors and not braces and support.bed_interface not in {"raft", "skate"}:
        return None

    # Slice with the radii the anchors were generated with, in case the
    # settings changed after generation (the preview still shows the old size).
    first = supports_json[0] if supports_json else {}
    return build_support_plan(
        tuple(anchors),
        tuple(braces),
        config,
        support,
        post_radius_mm=_optional_float(first.get("postRadius")),
        tip_radius_mm=_optional_float(first.get("tipRadius")),
        foot_radius_mm=_optional_float(first.get("footRadius")),
    )


def _optional_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result


def _paint_zones_from_request(request: dict[str, Any]) -> tuple[PaintZone, ...]:
    raw = request.get("supportPaint") or ()
    zones: list[PaintZone] = []
    for entry in raw:
        try:
            mode = str(entry.get("mode", "exclude")).lower()
            if mode not in {"exclude", "require"}:
                continue
            zones.append(
                PaintZone(
                    x=float(entry["x"]),
                    y=float(entry["y"]),
                    z=float(entry["z"]),
                    radius=max(0.05, float(entry.get("radius", 2.0))),
                    mode=mode,
                )
            )
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return tuple(zones)


def _layer_workers_from_request(request: dict[str, Any]) -> int | None:
    value = request.get("layerWorkers")
    if value in (None, ""):
        return None
    try:
        workers = int(value)
    except (TypeError, ValueError):
        raise SlicerError("layerWorkers must be an integer") from None
    return workers if workers > 0 else None


def _model_transform(model: dict[str, Any]) -> MeshTransform:
    transform = model.get("transform", {})
    return MeshTransform(
        rotate_x_deg=float(transform.get("rotateX", 0.0)),
        rotate_y_deg=float(transform.get("rotateY", 0.0)),
        rotate_z_deg=float(transform.get("rotateZ", 0.0)),
        scale=float(transform.get("scale", 1.0)),
        translate_x_mm=float(transform.get("translateX", 0.0)),
        translate_y_mm=float(transform.get("translateY", 0.0)),
        translate_z_mm=float(transform.get("translateZ", 0.0)),
    )


def _config_from_request(request: dict[str, Any]) -> PrintConfig:
    try:
        cfg = profile(request.get("profile", "generic-2k"))
    except ConfigError:
        cfg = profile("generic-2k")
    printer = request.get("printer", {})
    return cfg.with_overrides(
        resolution_x=int(printer.get("resolutionX", cfg.resolution_x)),
        resolution_y=int(printer.get("resolutionY", cfg.resolution_y)),
        size_x_mm=float(printer.get("sizeX", cfg.size_x_mm)),
        size_y_mm=float(printer.get("sizeY", cfg.size_y_mm)),
        size_z_mm=float(printer.get("sizeZ", cfg.size_z_mm)),
        layer_height_mm=float(printer.get("layerHeight", cfg.layer_height_mm)),
        exposure_time_s=float(printer.get("exposure", cfg.exposure_time_s)),
        bottom_exposure_time_s=float(printer.get("bottomExposure", cfg.bottom_exposure_time_s)),
        bottom_layers=int(printer.get("bottomLayers", cfg.bottom_layers)),
        transition_layers=int(printer.get("transitionLayers", cfg.transition_layers)),
        lift_distance_mm=float(printer.get("liftDistance", cfg.lift_distance_mm)),
        lift_speed_mm_min=float(printer.get("liftSpeed", cfg.lift_speed_mm_min)),
        retract_distance_mm=float(printer.get("retractDistance", cfg.retract_distance_mm)),
        retract_speed_mm_min=float(printer.get("retractSpeed", cfg.retract_speed_mm_min)),
        wait_after_retract_s=float(printer.get("waitAfterRetract", cfg.wait_after_retract_s)),
        rest_before_lift_s=float(printer.get("restBeforeLift", cfg.rest_before_lift_s)),
        rest_after_lift_s=float(printer.get("restAfterLift", cfg.rest_after_lift_s)),
        lift_distance2_mm=float(printer.get("liftDistance2", cfg.lift_distance2_mm)),
        lift_speed2_mm_min=float(printer.get("liftSpeed2", cfg.lift_speed2_mm_min)),
        retract_distance2_mm=float(printer.get("retractDistance2", cfg.retract_distance2_mm)),
        retract_speed2_mm_min=float(printer.get("retractSpeed2", cfg.retract_speed2_mm_min)),
        bottom_lift_distance_mm=float(printer.get("bottomLiftDistance", cfg.bottom_lift_distance_mm)),
        bottom_lift_speed_mm_min=float(printer.get("bottomLiftSpeed", cfg.bottom_lift_speed_mm_min)),
        bottom_retract_distance_mm=float(printer.get("bottomRetractDistance", cfg.bottom_retract_distance_mm)),
        bottom_retract_speed_mm_min=float(printer.get("bottomRetractSpeed", cfg.bottom_retract_speed_mm_min)),
        light_pwm=int(printer.get("lightPwm", cfg.light_pwm)),
        bottom_light_pwm=int(printer.get("bottomLightPwm", cfg.bottom_light_pwm)),
        machine_name=str(printer.get("machineName", cfg.machine_name)),
        resin_name=str(printer.get("resinName", cfg.resin_name)),
        resin_density_g_ml=float(printer.get("resinDensity", cfg.resin_density_g_ml)),
        center_model=bool(request.get("centerModel", cfg.center_model)),
        max_pixels_per_layer=int(printer.get("maxPixelsPerLayer", cfg.max_pixels_per_layer)),
    )


def _support_from_request(request: dict[str, Any]) -> SupportConfig:
    support = request.get("support", {})
    return SupportConfig(
        enabled=bool(support.get("enabled", True)),
        model_lift_mm=float(support.get("modelLift", 5.0)),
        mesh_minima_enabled=bool(support.get("meshMinimaEnabled", True)),
        min_island_area_mm2=float(support.get("minIslandArea", 0.08)),
        overhang_angle_deg=float(support.get("overhangAngle", 45.0)),
        support_spacing_mm=float(support.get("spacing", 3.0)),
        peel_density_enabled=bool(support.get("peelDensityEnabled", True)),
        peel_area_ref_mm2=float(support.get("peelAreaRef", 50.0)),
        peel_max_boost=float(support.get("peelMaxBoost", 2.0)),
        cup_detection_enabled=bool(support.get("cupDetectionEnabled", True)),
        cup_min_area_mm2=float(support.get("cupMinArea", 5.0)),
        primary_supports_enabled=bool(support.get("primarySupportsEnabled", False)),
        primary_density_multiplier=float(support.get("primaryDensityMultiplier", 2.0)),
        primary_area_radius_mm=_support_radius(support, "primaryAreaDiameter", "primaryAreaRadius", 4.0),
        primary_max_extra_per_island=int(support.get("primaryMaxExtra", 8)),
        post_radius_mm=_support_radius(support, "postDiameter", "postRadius", 0.28),
        tip_radius_mm=_support_radius(support, "tipDiameter", "tipRadius", 0.18),
        tip_type=str(support.get("tipType", "cone")),
        spherical_contact_enabled=bool(support.get("sphericalContactEnabled", False)),
        spherical_contact_diameter_mm=float(support.get("sphericalContactDiameter", 0.6)),
        spherical_contact_inset_mm=_spherical_contact_inset_mm(support),
        tip_length_mm=float(support.get("tipLength", 0.8)),
        foot_radius_mm=_support_radius(support, "footDiameter", "footRadius", 0.8),
        bed_interface=str(support.get("bedInterface", "raft")),
        raft_margin_mm=float(support.get("raftOffset", support.get("raftMargin", 0.6))),
        raft_chamfer_width_mm=float(support.get("raftChamferWidth", support.get("raft_chamfer_width_mm", 0.4))),
        raft_chamfer_angle_deg=float(support.get("raftChamferAngle", support.get("raft_chamfer_angle_deg", 45.0))),
        bed_interface_thickness_mm=float(support.get("bedInterfaceThickness", 0.35)),
        brace_enabled=bool(support.get("braceEnabled", True)),
        brace_radius_mm=_support_radius(support, "braceDiameter", "braceRadius", 0.18),
        brace_height_mm=float(support.get("braceHeight", 3.0)),
        brace_max_distance_mm=float(support.get("braceDistance", 8.0)),
        brace_interval_mm=float(support.get("braceInterval", 0.0)),
        collision_clearance_mm=float(support.get("collisionClearance", 0.08)),
        tree_supports_enabled=bool(support.get("treeSupportsEnabled", True)),
        max_support_angle_deg=float(support.get("maxSupportAngle", 35.0)),
        max_base_reach_mm=float(support.get("maxBaseReach", 20.0)),
        tree_stress_factor=float(support.get("treeStressFactor", 8.0)),
        enforcers_enabled=bool(support.get("enforcersEnabled", True)),
        enforcer_reach_mm=float(support.get("enforcerReach", 10.0)),
        enforcer_min_drop_mm=float(support.get("enforcerMinDrop", 1.0)),
        analysis_max_pixels=int(support.get("analysisPixels", 250_000)),
    )


def _support_radius(support: dict[str, Any], diameter_key: str, radius_key: str, default_radius: float) -> float:
    if diameter_key in support:
        return float(support.get(diameter_key, default_radius * 2.0)) * 0.5
    return float(support.get(radius_key, default_radius))


def _spherical_contact_inset_mm(support: dict[str, Any]) -> float:
    diameter = float(support.get("sphericalContactDiameter", 0.6))
    if "sphericalContactInsetPercent" in support:
        percent = min(95.0, max(5.0, float(support.get("sphericalContactInsetPercent", 50.0))))
        return diameter * percent / 100.0
    return float(support.get("sphericalContactInset", diameter * 0.5))


def _transform_from_request(request: dict[str, Any]) -> MeshTransform:
    transform = request.get("transform", {})
    return MeshTransform(
        rotate_x_deg=float(transform.get("rotateX", 0.0)),
        rotate_y_deg=float(transform.get("rotateY", 0.0)),
        rotate_z_deg=float(transform.get("rotateZ", 0.0)),
        scale=float(transform.get("scale", 1.0)),
        translate_x_mm=float(transform.get("translateX", 0.0)),
        translate_y_mm=float(transform.get("translateY", 0.0)),
        translate_z_mm=float(transform.get("translateZ", 0.0)),
    )


def _support_to_json(anchor: Any, plan: SupportPlan | None, config: PrintConfig, support: SupportConfig) -> dict[str, Any]:
    base_x = anchor.base_x if anchor.base_x is not None else anchor.x
    base_y = anchor.base_y if anchor.base_y is not None else anchor.y
    joint_x = anchor.joint_x if anchor.joint_x is not None else anchor.x
    joint_y = anchor.joint_y if anchor.joint_y is not None else anchor.y
    joint_layer = anchor.joint_layer if anchor.joint_layer is not None else anchor.top_layer
    return {
        "x": (anchor.x + 0.5) * config.pixel_size_x_mm,
        "y": (anchor.y + 0.5) * config.pixel_size_y_mm,
        "baseX": (base_x + 0.5) * config.pixel_size_x_mm,
        "baseY": (base_y + 0.5) * config.pixel_size_y_mm,
        "baseZ": (anchor.base_layer + 0.5) * config.layer_height_mm,
        "jointX": (joint_x + 0.5) * config.pixel_size_x_mm,
        "jointY": (joint_y + 0.5) * config.pixel_size_y_mm,
        "jointZ": (joint_layer + 1) * config.layer_height_mm,
        "z": (anchor.top_layer + 1) * config.layer_height_mm,
        "topLayer": anchor.top_layer,
        "baseLayer": anchor.base_layer,
        "jointLayer": joint_layer,
        "kind": anchor.kind,
        "role": anchor.role,
        "load": anchor.load,
        "junctions": [list(junction) for junction in anchor.junctions],
        "trunkScale": round(anchor_trunk_scale(anchor, support.post_radius_mm, support.tree_stress_factor), 3),
        "postRadius": support.post_radius_mm,
        "tipRadius": support.tip_radius_mm,
        "tipType": anchor.tip_type,
        "normal": {
            "x": anchor.normal_x,
            "y": anchor.normal_y,
            "z": anchor.normal_z,
        },
        "sphericalContactEnabled": support.spherical_contact_enabled,
        "sphericalContactDiameter": support.spherical_contact_diameter_mm,
        "sphericalContactInset": support.spherical_contact_inset_mm,
        "sphericalContactInsetPercent": (
            100.0 * support.spherical_contact_inset_mm / support.spherical_contact_diameter_mm
            if support.spherical_contact_diameter_mm > 0
            else 50.0
        ),
        "footRadius": support.foot_radius_mm,
        "bedInterfaceThickness": support.bed_interface_thickness_mm,
    }


def _brace_to_json(brace: Any, config: PrintConfig) -> dict[str, float | int]:
    z0 = (brace.start_layer + 0.5) * config.layer_height_mm
    z1 = (brace.end_layer + 0.5) * config.layer_height_mm
    return {
        "x0": (brace.x0 + 0.5) * config.pixel_size_x_mm,
        "y0": (brace.y0 + 0.5) * config.pixel_size_y_mm,
        "x1": (brace.x1 + 0.5) * config.pixel_size_x_mm,
        "y1": (brace.y1 + 0.5) * config.pixel_size_y_mm,
        "z": z0,
        "z0": z0,
        "z1": z1,
        "startLayer": brace.start_layer,
        "endLayer": brace.end_layer,
        "radius": brace.radius_px * min(config.pixel_size_x_mm, config.pixel_size_y_mm),
    }


def _raft_preview_to_json(prepared: Any, config: PrintConfig, support: SupportConfig) -> dict[str, Any] | None:
    if support.bed_interface not in {"raft", "skate"}:
        return None
    bounds = prepared.mesh.bounds()
    margin = max(0.0, support.raft_margin_mm)
    payload: dict[str, Any] = {
        "type": support.bed_interface,
        "x0": bounds.min_x - margin,
        "y0": bounds.min_y - margin,
        "x1": bounds.max_x + margin,
        "y1": bounds.max_y + margin,
        "offset": margin,
        "thickness": support.bed_interface_thickness_mm,
    }
    rects = _raft_preview_rects(prepared, config, support)
    if rects:
        payload["rects"] = rects
    return payload


def _raft_preview_rects(prepared: Any, config: PrintConfig, support: SupportConfig) -> list[list[float]] | None:
    """The actual raft footprint (the model's projected shadow dilated by the
    raft margin, exactly like slicing computes it) as row-span rectangles in mm,
    rasterised at the coarse analysis resolution to keep the preview cheap."""
    try:
        analysis = _analysis_config(config, support)
        shadow = LayerRaster(analysis.resolution_x, analysis.resolution_y)
        for triangle in prepared.mesh.triangles:
            _add_projected_triangle(shadow, triangle, analysis)
        if shadow.count_on() == 0:
            return None
        offset_px = 0
        if support.raft_margin_mm > 0:
            offset_px = mm_to_px(support.raft_margin_mm, min(analysis.pixel_size_x_mm, analysis.pixel_size_y_mm))
        # dilate_mask returns 0/1 bytes; expand to the 0/255 convention that
        # nonzero_spans scans for.
        binary_to_raster = bytes(255 if value else 0 for value in range(256))
        mask = LayerRaster(
            analysis.resolution_x,
            analysis.resolution_y,
            bytearray(dilate_mask(shadow, offset_px).translate(binary_to_raster)),
        )
        pixel_x = analysis.pixel_size_x_mm
        pixel_y = analysis.pixel_size_y_mm
        rects: list[list[float]] = []
        for start, end in mask.nonzero_spans():
            y = start // mask.width
            x0 = start % mask.width
            x1 = x0 + (end - start)
            rects.append(
                [
                    round(x0 * pixel_x, 3),
                    round(y * pixel_y, 3),
                    round(x1 * pixel_x, 3),
                    round((y + 1) * pixel_y, 3),
                ]
            )
        return rects
    except Exception:
        return None


if __name__ == "__main__":
    raise SystemExit(main())
