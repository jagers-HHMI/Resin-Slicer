from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator

from .config import PrintConfig, SupportConfig
from .errors import FormatError
from .formats.ctb import write_ctb
from .formats.goo import write_goo
from .mesh import Mesh
from .raster import LayerRaster
from .slicing import PreparedMesh, prepare_mesh, render_prepared_layer
from .supports import PaintZone, SupportPlan, SupportReport, apply_supports, attach_raft_masks, plan_supports_verified
from .transform import MeshTransform, apply_transform

try:
    from .cad_slicing import CadSliceModel, CadSliceSource, prepare_cad_slice_source
except Exception:  # pragma: no cover - CAD dependencies are optional until STEP/B-rep mode is used.
    CadSliceModel = object  # type: ignore[assignment]
    CadSliceSource = object  # type: ignore[assignment]
    prepare_cad_slice_source = None  # type: ignore[assignment]

Progress = Callable[[str], None]


@dataclass(frozen=True)
class SliceJob:
    mesh: Mesh
    print_config: PrintConfig
    support_config: SupportConfig = SupportConfig()
    transform: MeshTransform = MeshTransform()
    preserve_coordinates: bool = False
    raster_mesh: Mesh | None = None
    cad_models: tuple[CadSliceModel, ...] = ()
    cad_slice_mode: str = "tessellated"
    manual_support_points: tuple[tuple[float, float, float], ...] = ()
    support_paint: tuple[PaintZone, ...] = ()
    # Plan only the manual/painted supports (the user never ran the automatic
    # generator, so slicing must not invent supports they did not ask for).
    manual_support_only: bool = False


@dataclass(frozen=True)
class SliceResult:
    layer_count: int
    support_count: int
    material_ml: float
    output_path: Path
    preview_dir: str | None = None
    # Diagnostics from support planning; None when a precomputed (already
    # previewed/verified) plan was reused, so nothing new was analysed.
    support_report: SupportReport | None = None


def slice_to_file(
    job: SliceJob,
    output_path: str | Path,
    fmt: str,
    progress: Progress | None = None,
    layer_workers: int | None = None,
    preview_dir: str | None = None,
    preview_scale: int = 1,
    precomputed_support_plan: SupportPlan | None = None,
) -> SliceResult:
    config = job.print_config
    support_config = job.support_config
    config.validate()
    support_config.validate()
    orientation = MeshTransform(
        rotate_x_deg=job.transform.rotate_x_deg,
        rotate_y_deg=job.transform.rotate_y_deg,
        rotate_z_deg=job.transform.rotate_z_deg,
        scale=job.transform.scale,
    )
    mesh = apply_transform(job.mesh, orientation)
    model_lift = support_config.model_lift_mm if support_config.enabled else 0.0
    prepared, model_prepared, cad_source = _prepare_slice_sources(job, mesh, orientation, config, model_lift)
    output = Path(output_path)
    fmt = fmt.lower().lstrip(".")
    if fmt not in {"goo", "ctb"}:
        raise FormatError("output format must be 'goo' or 'ctb'")

    if progress:
        progress(f"prepared mesh: {prepared.layer_count} layers")

    support_plan = SupportPlan((), 0, 0, 0, 0.0, 0)
    support_report: SupportReport | None = None
    supports_enabled = support_config.enabled
    if support_config.enabled:
        if precomputed_support_plan is not None:
            # A plan from an earlier support-generation pass; only the raft masks
            # (skipped during previews) still need to be computed.
            support_plan = attach_raft_masks(precomputed_support_plan, prepared, config, support_config)
            if progress:
                progress(f"reusing {len(support_plan.anchors)} previously generated supports")
        else:
            if progress:
                progress("planning supports")
            support_plan, support_report = plan_supports_verified(
                prepared,
                config,
                support_config,
                prepared.layer_count,
                progress=progress,
                manual_points=job.manual_support_points,
                paint_zones=job.support_paint,
                manual_only=job.manual_support_only,
            )
            if progress:
                progress(f"planned {len(support_plan.anchors)} supports")
                if support_report.rescue_count:
                    progress(f"verification added {support_report.rescue_count} rescue supports")
                if support_report.failed_routes:
                    if support_report.residual_islands or not support_report.verified:
                        progress(f"WARNING: {support_report.failed_routes} support points could not be routed")
                    else:
                        # Redundant candidates failed but verification confirmed
                        # every region is still covered by the other supports.
                        progress(
                            f"{support_report.failed_routes} candidate points could not be routed; "
                            "verification confirmed full coverage without them"
                        )
                if support_report.residual_islands:
                    progress(
                        f"WARNING: {len(support_report.residual_islands)} unsupported island(s) "
                        "remain in the sliced output"
                    )
                if support_report.suction_cups:
                    progress(
                        f"WARNING: {len(support_report.suction_cups)} suction cup(s) detected; "
                        "consider drain holes or tilting"
                    )
        supports_enabled = _support_plan_has_geometry(support_plan)
        if not supports_enabled and model_lift > 0:
            if progress:
                progress("no support structure generated; dropping model to build plate")
            model_lift = 0.0
            prepared, model_prepared, cad_source = _prepare_slice_sources(job, mesh, orientation, config, model_lift)

    if progress:
        progress(f"writing {fmt}")
    layer_gen = _layer_iter(prepared, model_prepared, config, supports_enabled, support_plan, progress, layer_workers, cad_source)
    if preview_dir:
        layer_gen = _preview_writing_iter(layer_gen, preview_dir, preview_scale)
    if fmt == "goo":
        stats = write_goo(output, config, prepared.layer_count, layer_gen)
    else:
        stats = write_ctb(output, config, prepared.layer_count, layer_gen)

    return SliceResult(
        layer_count=prepared.layer_count,
        support_count=len(support_plan.anchors),
        material_ml=stats.material_mm3 / 1000.0,
        output_path=output,
        preview_dir=preview_dir,
        support_report=support_report,
    )


def _prepare_slice_sources(
    job: SliceJob,
    mesh: Mesh,
    orientation: MeshTransform,
    config: PrintConfig,
    model_lift: float,
) -> tuple[PreparedMesh, PreparedMesh | None, CadSliceSource | None]:
    z_offset = model_lift + job.transform.translate_z_mm
    prepared = prepare_mesh(
        mesh,
        config,
        z_offset_mm=z_offset,
        xy_offset_mm=(job.transform.translate_x_mm, job.transform.translate_y_mm),
        preserve_coordinates=job.preserve_coordinates,
    )
    model_prepared: PreparedMesh | None = prepared
    if job.raster_mesh is not None:
        raster_mesh = apply_transform(job.raster_mesh, orientation)
        model_prepared = prepare_mesh(
            raster_mesh,
            config,
            z_offset_mm=z_offset,
            xy_offset_mm=(job.transform.translate_x_mm, job.transform.translate_y_mm),
            preserve_coordinates=job.preserve_coordinates,
        )
    elif job.cad_slice_mode == "brep" and job.cad_models:
        model_prepared = None

    cad_source = None
    if job.cad_slice_mode == "brep" and job.cad_models:
        if prepare_cad_slice_source is None:
            raise FormatError("B-rep slicing requires OpenCascade/build123d")
        cad_source = prepare_cad_slice_source(job.cad_models, z_offset_mm=z_offset)
    return prepared, model_prepared, cad_source


def _support_plan_has_geometry(plan: SupportPlan) -> bool:
    return bool(plan.anchors or plan.braces or plan.raft_mask)


def _progress_interval(total: int) -> int:
    return max(1, total // 20)


def _layer_iter(
    support_prepared: PreparedMesh,
    model_prepared: PreparedMesh | None,
    config: PrintConfig,
    supports_enabled: bool,
    support_plan: SupportPlan,
    progress: Progress | None,
    layer_workers: int | None,
    cad_source: CadSliceSource | None = None,
) -> Iterator[tuple[int, LayerRaster]]:
    total = support_prepared.layer_count
    workers = _resolve_layer_workers(layer_workers, total)
    interval = _progress_interval(total)

    if workers <= 1:
        for layer_index in range(total):
            if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
                progress(f"writing layer {layer_index + 1}/{total}")
            yield _render_layer(support_prepared, model_prepared, config, supports_enabled, support_plan, layer_index, cad_source)
        return

    if progress:
        progress(f"rendering layers with {workers} worker threads")

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="slice-layer") as executor:
        futures = {}
        next_submit = 0
        next_yield = 0

        while next_yield < total:
            while next_submit < total and len(futures) < workers:
                futures[next_submit] = executor.submit(
                    _render_layer,
                    support_prepared,
                    model_prepared,
                    config,
                    supports_enabled,
                    support_plan,
                    next_submit,
                    cad_source,
                )
                next_submit += 1

            layer_index, layer = futures.pop(next_yield).result()
            if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
                progress(f"writing layer {layer_index + 1}/{total}")
            next_yield += 1
            yield layer_index, layer


def _preview_writing_iter(
    base_iter: Iterator[tuple[int, LayerRaster]],
    preview_dir: str,
    scale: int,
) -> Iterator[tuple[int, LayerRaster]]:
    for layer_index, layer in base_iter:
        png = layer.to_png_bytes(scale)
        path = os.path.join(preview_dir, f"layer_{layer_index + 1:05d}.png")
        with open(path, "wb") as fh:
            fh.write(png)
        yield layer_index, layer


def _render_layer(
    support_prepared: PreparedMesh,
    model_prepared: PreparedMesh | None,
    config: PrintConfig,
    supports_enabled: bool,
    support_plan: SupportPlan,
    layer_index: int,
    cad_source: CadSliceSource | None = None,
) -> tuple[int, LayerRaster]:
    if cad_source is not None:
        layer = cad_source.render_layer(layer_index, config)
        if model_prepared is not None:
            layer.or_with(render_prepared_layer(model_prepared, config, layer_index))
    else:
        layer = render_prepared_layer(model_prepared or support_prepared, config, layer_index)
    if supports_enabled:
        apply_supports(layer, layer_index, support_plan)
    return layer_index, layer


def _resolve_layer_workers(requested: int | None, layer_count: int) -> int:
    if layer_count <= 1:
        return 1
    if requested is None:
        requested = _env_layer_workers()
    if requested is None:
        requested = min(4, os.cpu_count() or 1)
    return max(1, min(layer_count, int(requested)))


def _env_layer_workers() -> int | None:
    value = os.environ.get("RESIN_SLICER_LAYER_WORKERS")
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None
