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
from .supports import SupportPlan, apply_supports, plan_supports
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


@dataclass(frozen=True)
class SliceResult:
    layer_count: int
    support_count: int
    material_ml: float
    output_path: Path


def slice_to_file(
    job: SliceJob,
    output_path: str | Path,
    fmt: str,
    progress: Progress | None = None,
    layer_workers: int | None = None,
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
    prepared = prepare_mesh(
        mesh,
        config,
        z_offset_mm=model_lift + job.transform.translate_z_mm,
        xy_offset_mm=(job.transform.translate_x_mm, job.transform.translate_y_mm),
        preserve_coordinates=job.preserve_coordinates,
    )
    model_prepared: PreparedMesh | None = prepared
    if job.raster_mesh is not None:
        raster_mesh = apply_transform(job.raster_mesh, orientation)
        model_prepared = prepare_mesh(
            raster_mesh,
            config,
            z_offset_mm=model_lift + job.transform.translate_z_mm,
            xy_offset_mm=(job.transform.translate_x_mm, job.transform.translate_y_mm),
            preserve_coordinates=job.preserve_coordinates,
        )
    elif job.cad_slice_mode == "brep" and job.cad_models:
        model_prepared = None
    cad_source = None
    if job.cad_slice_mode == "brep" and job.cad_models:
        if prepare_cad_slice_source is None:
            raise FormatError("B-rep slicing requires OpenCascade/build123d")
        cad_source = prepare_cad_slice_source(
            job.cad_models,
            z_offset_mm=model_lift + job.transform.translate_z_mm,
        )
    output = Path(output_path)
    fmt = fmt.lower().lstrip(".")
    if fmt not in {"goo", "ctb"}:
        raise FormatError("output format must be 'goo' or 'ctb'")

    if progress:
        progress(f"prepared mesh: {prepared.layer_count} layers")

    support_plan = SupportPlan((), 0, 0, 0, 0.0, 0)
    if support_config.enabled:
        if progress:
            progress("planning supports")
        support_plan = plan_supports(
            prepared,
            config,
            support_config,
            prepared.layer_count,
            progress=progress,
        )
        if progress:
            progress(f"planned {len(support_plan.anchors)} supports")

    if progress:
        progress(f"writing {fmt}")
    if fmt == "goo":
        stats = write_goo(
            output,
            config,
            prepared.layer_count,
            _layer_iter(prepared, model_prepared, config, support_config.enabled, support_plan, progress, layer_workers, cad_source),
        )
    else:
        stats = write_ctb(
            output,
            config,
            prepared.layer_count,
            _layer_iter(prepared, model_prepared, config, support_config.enabled, support_plan, progress, layer_workers, cad_source),
        )

    return SliceResult(
        layer_count=prepared.layer_count,
        support_count=len(support_plan.anchors),
        material_ml=stats.material_mm3 / 1000.0,
        output_path=output,
    )


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
