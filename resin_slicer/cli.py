from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import PrintConfig, SupportConfig, profile
from .errors import SlicerError
from .mesh import load_mesh
from .pipeline import SliceJob, slice_to_file
from .transform import MeshTransform


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        config = _config_from_args(args)
        supports = SupportConfig(
            enabled=not args.no_supports,
            model_lift_mm=args.model_lift,
            mesh_minima_enabled=not args.no_mesh_minima,
            overhang_angle_deg=args.overhang_angle,
            support_spacing_mm=args.support_spacing,
            peel_density_enabled=not args.no_peel_density,
            peel_area_ref_mm2=args.peel_area_ref,
            peel_max_boost=args.peel_max_boost,
            cup_detection_enabled=not args.no_cup_detection,
            cup_min_area_mm2=args.cup_min_area,
            primary_supports_enabled=args.primary_supports,
            primary_density_multiplier=args.primary_density_multiplier,
            primary_area_radius_mm=args.primary_area_radius,
            primary_max_extra_per_island=args.primary_max_extra,
            post_radius_mm=args.support_radius,
            tip_radius_mm=args.tip_radius,
            tip_type=args.tip_type,
            tip_length_mm=args.tip_length,
            foot_radius_mm=args.foot_radius,
            bed_interface=args.bed_interface,
            raft_margin_mm=args.raft_offset,
            raft_chamfer_width_mm=args.raft_chamfer_width,
            raft_chamfer_angle_deg=args.raft_chamfer_angle,
            bed_interface_thickness_mm=args.bed_interface_thickness,
            brace_enabled=not args.no_braces,
            brace_radius_mm=args.brace_radius,
            brace_height_mm=args.brace_height,
            brace_max_distance_mm=args.brace_distance,
            collision_clearance_mm=args.collision_clearance,
            tree_supports_enabled=not args.no_tree_supports,
            max_support_angle_deg=args.max_support_angle,
            max_base_reach_mm=args.max_base_reach,
            tree_stress_factor=args.tree_stress_factor,
            enforcers_enabled=not args.no_enforcers,
            enforcer_reach_mm=args.enforcer_reach,
            enforcer_min_drop_mm=args.enforcer_min_drop,
            min_island_area_mm2=args.min_island_area,
            analysis_max_pixels=args.support_analysis_pixels,
        )
        mesh = load_mesh(args.input)
        transform = MeshTransform(
            rotate_x_deg=args.rotate_x,
            rotate_y_deg=args.rotate_y,
            rotate_z_deg=args.rotate_z,
            scale=args.scale,
            translate_x_mm=args.translate[0],
            translate_y_mm=args.translate[1],
            translate_z_mm=args.translate[2],
        )
        fmt = args.format or Path(args.output).suffix.lstrip(".")
        result = slice_to_file(
            SliceJob(mesh, config, supports, transform),
            args.output,
            fmt,
            progress=(lambda message: print(message, file=sys.stderr)) if args.verbose else None,
            layer_workers=args.workers,
        )
    except SlicerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    print(
        f"wrote {result.output_path} ({result.layer_count} layers, "
        f"{result.support_count} supports, {result.material_ml:.2f} ml estimated resin)"
    )
    report = result.support_report
    if report is not None:
        if report.failed_routes and (report.residual_islands or not report.verified):
            print(f"warning: {report.failed_routes} support points could not be routed", file=sys.stderr)
        if report.residual_islands:
            print(
                f"warning: {len(report.residual_islands)} unsupported island(s) remain; "
                "the print may fail in those regions",
                file=sys.stderr,
            )
        for cup in report.suction_cups:
            print(
                f"warning: suction cup at ({cup.x_mm:.1f}, {cup.y_mm:.1f}, {cup.z_mm:.1f})mm — "
                f"{cup.mouth_area_mm2:.0f}mm² mouth, {cup.volume_mm3 / 1000.0:.2f}ml cavity; "
                "consider a drain hole or tilting the part",
                file=sys.stderr,
            )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Slice an STL, OBJ, STEP, or STP model for MSLA resin printers.")
    parser.add_argument("input", help="input STL, OBJ, STEP, or STP file")
    parser.add_argument("-o", "--output", required=True, help="output .goo or .ctb path")
    parser.add_argument("--format", choices=["goo", "ctb"], help="output format; defaults to output extension")
    parser.add_argument("--profile", default="generic-2k", help="printer profile name")
    parser.add_argument("--resolution", help="override resolution as WIDTHxHEIGHT pixels")
    parser.add_argument("--volume", help="override build volume as XxYxZ millimeters")
    parser.add_argument("--layer-height", type=float, help="layer height in millimeters")
    parser.add_argument("--exposure", type=float, help="normal exposure in seconds")
    parser.add_argument("--bottom-exposure", type=float, help="bottom exposure in seconds")
    parser.add_argument("--bottom-layers", type=int, help="number of bottom layers")
    parser.add_argument("--transition-layers", type=int, help="number of transition layers")
    parser.add_argument("--lift-distance", type=float, help="normal lift distance in millimeters")
    parser.add_argument("--lift-speed", type=float, help="normal lift speed in millimeters per minute")
    parser.add_argument("--retract-distance", type=float, help="retract distance in millimeters")
    parser.add_argument("--retract-speed", type=float, help="retract speed in millimeters per minute")
    parser.add_argument("--wait-after-retract", type=float, help="wait time after retract in seconds")
    parser.add_argument("--light-pwm", type=int, help="normal layer light PWM, 0..255")
    parser.add_argument("--bottom-light-pwm", type=int, help="bottom layer light PWM, 0..255")
    parser.add_argument("--machine-name", help="machine name written to the output file")
    parser.add_argument("--resin-name", help="resin/profile name written to the output file")
    parser.add_argument("--resin-density", type=float, help="resin density in grams per milliliter")
    parser.add_argument("--no-center", action="store_true", help="place mesh at its source-file origin instead of centering")
    parser.add_argument("--rotate-x", type=float, default=0.0, help="rotate model around its center on the X axis, degrees")
    parser.add_argument("--rotate-y", type=float, default=0.0, help="rotate model around its center on the Y axis, degrees")
    parser.add_argument("--rotate-z", type=float, default=0.0, help="rotate model around its center on the Z axis, degrees")
    parser.add_argument("--scale", type=float, default=1.0, help="uniform model scale applied before placement")
    parser.add_argument(
        "--translate",
        type=_parse_translate_arg,
        default=(0.0, 0.0, 0.0),
        help="translate model as XxYxZ millimeters before final placement",
    )
    parser.add_argument("--max-pixels-per-layer", type=int, help="raise or lower layer memory safety limit")
    parser.add_argument(
        "--workers",
        type=int,
        help="worker threads for layer rendering; defaults to RESIN_SLICER_LAYER_WORKERS or up to 4",
    )
    parser.add_argument("--no-supports", action="store_true", help="disable automatic support generation")
    parser.add_argument(
        "--no-mesh-minima",
        action="store_true",
        help="disable mesh-based local-minima support tips (enabled by default)",
    )
    parser.add_argument("--model-lift", type=float, default=5.0, help="raise supported models this many millimeters above the plate")
    parser.add_argument(
        "--overhang-angle",
        type=float,
        default=45.0,
        help="minimum self-supporting angle from the build plate in degrees; higher values create more supports",
    )
    parser.add_argument("--support-spacing", type=float, default=3.0, help="target support spacing in millimeters")
    parser.add_argument(
        "--no-peel-density",
        action="store_true",
        help="disable peel-force-aware density (uniform spacing regardless of region area)",
    )
    parser.add_argument("--peel-area-ref", type=float, default=50.0, help="region area in mm^2 at which peel-aware tip count doubles")
    parser.add_argument("--peel-max-boost", type=float, default=2.0, help="maximum peel-aware spacing divisor")
    parser.add_argument("--no-cup-detection", action="store_true", help="disable suction-cup detection warnings")
    parser.add_argument("--cup-min-area", type=float, default=5.0, help="minimum suction-cup mouth area in mm^2 worth warning about")
    parser.add_argument("--primary-supports", action="store_true", help="add denser primary supports around each detected island")
    parser.add_argument("--primary-density-multiplier", type=float, default=2.0, help="density multiplier for primary island attachment regions")
    parser.add_argument("--primary-area-radius", type=float, default=4.0, help="primary attachment region radius around each island centroid in millimeters")
    parser.add_argument("--primary-max-extra", type=int, default=8, help="maximum extra primary supports per island")
    parser.add_argument("--support-radius", type=float, default=0.28, help="support post radius in millimeters")
    parser.add_argument("--tip-radius", type=float, default=0.18, help="support contact/tip radius in millimeters")
    parser.add_argument("--tip-type", choices=["cone", "sphere", "cylinder"], default="cone", help="tip radius profile")
    parser.add_argument("--tip-length", type=float, default=0.8, help="tip segment length in millimeters")
    parser.add_argument("--foot-radius", type=float, default=0.8, help="support foot radius in millimeters")
    parser.add_argument(
        "--bed-interface",
        choices=["none", "feet", "raft", "skate"],
        default="raft",
        help="build-plate interface style for support bases",
    )
    parser.add_argument(
        "--raft-offset",
        "--raft-margin",
        dest="raft_offset",
        type=float,
        default=0.6,
        help="offset distance around the projected model footprint for raft/skate interfaces",
    )
    parser.add_argument("--raft-chamfer-width", type=float, default=0.4, help="horizontal width of the raft bottom-edge chamfer in millimeters")
    parser.add_argument("--raft-chamfer-angle", type=float, default=45.0, help="raft bottom-edge chamfer angle in degrees")
    parser.add_argument("--bed-interface-thickness", type=float, default=0.35, help="bed support interface thickness in millimeters")
    parser.add_argument("--no-braces", action="store_true", help="disable cross-bracing between nearby supports")
    parser.add_argument("--brace-radius", type=float, default=0.18, help="cross-brace radius in millimeters")
    parser.add_argument("--brace-height", type=float, default=3.0, help="starting height for diagonal braces above the bed in millimeters")
    parser.add_argument("--brace-distance", type=float, default=8.0, help="maximum distance between braced supports in millimeters")
    parser.add_argument("--collision-clearance", type=float, default=0.08, help="clearance around routed supports during collision checks")
    parser.add_argument(
        "--no-tree-supports",
        action="store_true",
        help="keep every support as its own pillar instead of merging nearby shafts into shared trunks",
    )
    parser.add_argument("--max-support-angle", type=float, default=35.0, help="maximum lean from vertical for merged tree shafts, degrees")
    parser.add_argument("--max-base-reach", type=float, default=20.0, help="maximum horizontal distance a shaft may travel to reach a trunk, millimeters")
    parser.add_argument(
        "--tree-stress-factor",
        type=float,
        default=8.0,
        help="trunk stress budget as a multiple of a lone post's axial stress; lower = thicker, earlier-saturating trunks",
    )
    parser.add_argument(
        "--no-enforcers",
        action="store_true",
        help="disable part-to-part enforcer supports for bed-inaccessible regions (enabled by default)",
    )
    parser.add_argument("--enforcer-reach", type=float, default=10.0, help="maximum horizontal part-to-part enforcer search distance")
    parser.add_argument("--enforcer-min-drop", type=float, default=1.0, help="minimum vertical drop for part-to-part enforcers")
    parser.add_argument("--min-island-area", type=float, default=0.08, help="minimum unsupported island area in mm^2")
    parser.add_argument(
        "--support-analysis-pixels",
        type=int,
        default=250_000,
        help="pixel budget for automatic support analysis before scaling anchors to output resolution",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="print progress to stderr")
    return parser


def _config_from_args(args: argparse.Namespace) -> PrintConfig:
    config = profile(args.profile)
    overrides: dict[str, object] = {}
    if args.resolution:
        x, y = _parse_pair(args.resolution, "resolution")
        overrides["resolution_x"] = int(x)
        overrides["resolution_y"] = int(y)
    if args.volume:
        x, y, z = _parse_triple(args.volume, "volume")
        overrides["size_x_mm"] = x
        overrides["size_y_mm"] = y
        overrides["size_z_mm"] = z
    if args.layer_height is not None:
        overrides["layer_height_mm"] = args.layer_height
    if args.exposure is not None:
        overrides["exposure_time_s"] = args.exposure
    if args.bottom_exposure is not None:
        overrides["bottom_exposure_time_s"] = args.bottom_exposure
    if args.bottom_layers is not None:
        overrides["bottom_layers"] = args.bottom_layers
    if args.transition_layers is not None:
        overrides["transition_layers"] = args.transition_layers
    if args.lift_distance is not None:
        overrides["lift_distance_mm"] = args.lift_distance
    if args.lift_speed is not None:
        overrides["lift_speed_mm_min"] = args.lift_speed
    if args.retract_distance is not None:
        overrides["retract_distance_mm"] = args.retract_distance
    if args.retract_speed is not None:
        overrides["retract_speed_mm_min"] = args.retract_speed
    if args.wait_after_retract is not None:
        overrides["wait_after_retract_s"] = args.wait_after_retract
    if args.light_pwm is not None:
        overrides["light_pwm"] = args.light_pwm
    if args.bottom_light_pwm is not None:
        overrides["bottom_light_pwm"] = args.bottom_light_pwm
    if args.machine_name is not None:
        overrides["machine_name"] = args.machine_name
    if args.resin_name is not None:
        overrides["resin_name"] = args.resin_name
    if args.resin_density is not None:
        overrides["resin_density_g_ml"] = args.resin_density
    if args.no_center:
        overrides["center_model"] = False
    if args.max_pixels_per_layer is not None:
        overrides["max_pixels_per_layer"] = args.max_pixels_per_layer
    return config.with_overrides(**overrides)


def _parse_pair(value: str, label: str) -> tuple[float, float]:
    parts = value.lower().split("x")
    if len(parts) != 2:
        raise SlicerError(f"{label} must be formatted as XxY")
    return float(parts[0]), float(parts[1])


def _parse_triple(value: str, label: str) -> tuple[float, float, float]:
    parts = value.lower().split("x")
    if len(parts) != 3:
        raise SlicerError(f"{label} must be formatted as XxYxZ")
    return float(parts[0]), float(parts[1]), float(parts[2])


def _parse_translate_arg(value: str) -> tuple[float, float, float]:
    return _parse_triple(value, "translate")


if __name__ == "__main__":
    raise SystemExit(main())
