from __future__ import annotations

import argparse
import json
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .cad_slicing import CadSliceModel
from .config import PROFILES, PrintConfig, SupportConfig, profile
from .errors import ConfigError, SlicerError
from .mesh import Mesh, load_mesh
from .pipeline import SliceJob, slice_to_file
from .slicing import prepare_mesh
from .supports import SupportPlan, plan_supports
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
    plan = SupportPlan((), 0, 0, 0, 0.0, 0)
    if support.enabled:
        def _emit_support(anchor: Any) -> None:
            _write_json({"type": "support", "support": _support_to_json(anchor, None, config, support)})

        plan = plan_supports(
            prepared,
            config,
            support,
            prepared.layer_count,
            progress=lambda message: _write_json({"type": "progress", "message": message}),
            include_raft_mask=False,
            on_anchor=_emit_support,
        )

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
            "raft": _raft_preview_to_json(prepared, support) if support.enabled else None,
            "supportCount": len(plan.anchors),
            "materialLiftMm": model_lift,
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
    preview_scale = max(1, config.resolution_x // 480)
    preview_dir = tempfile.mkdtemp(prefix="rspreview_")
    result = slice_to_file(
        SliceJob(
            mesh=mesh,
            print_config=config,
            support_config=_support_from_request(request),
            transform=transform,
            preserve_coordinates=has_model_entries,
            raster_mesh=raster_mesh,
            cad_models=cad_models,
            cad_slice_mode=cad_slice_mode,
        ),
        request["outputPath"],
        request.get("format", "goo"),
        progress=lambda message: _write_json({"type": "progress", "message": message}),
        layer_workers=_layer_workers_from_request(request),
        preview_dir=preview_dir,
        preview_scale=preview_scale,
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
        }
    )


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
        min_island_area_mm2=float(support.get("minIslandArea", 0.08)),
        overhang_angle_deg=float(support.get("overhangAngle", 45.0)),
        support_spacing_mm=float(support.get("spacing", 3.0)),
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
        collision_clearance_mm=float(support.get("collisionClearance", 0.08)),
        max_base_reach_mm=float(support.get("maxBaseReach", 45.0)),
        max_support_angle_deg=float(support.get("maxSupportAngle", 35.0)),
        enforcers_enabled=bool(support.get("enforcersEnabled", False)),
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


def _raft_preview_to_json(prepared: Any, support: SupportConfig) -> dict[str, float | str] | None:
    if support.bed_interface not in {"raft", "skate"}:
        return None
    bounds = prepared.mesh.bounds()
    margin = max(0.0, support.raft_margin_mm)
    return {
        "type": support.bed_interface,
        "x0": bounds.min_x - margin,
        "y0": bounds.min_y - margin,
        "x1": bounds.max_x + margin,
        "y1": bounds.max_y + margin,
        "offset": margin,
        "thickness": support.bed_interface_thickness_mm,
    }


if __name__ == "__main__":
    raise SystemExit(main())
