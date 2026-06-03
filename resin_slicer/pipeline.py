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

Progress = Callable[[str], None]


@dataclass(frozen=True)
class SliceJob:
    mesh: Mesh
    print_config: PrintConfig
    support_config: SupportConfig = SupportConfig()
    transform: MeshTransform = MeshTransform()
    preserve_coordinates: bool = False


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
            _layer_iter(prepared, config, support_config.enabled, support_plan, progress, layer_workers),
        )
    else:
        stats = write_ctb(
            output,
            config,
            prepared.layer_count,
            _layer_iter(prepared, config, support_config.enabled, support_plan, progress, layer_workers),
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
    prepared: PreparedMesh,
    config: PrintConfig,
    supports_enabled: bool,
    support_plan: SupportPlan,
    progress: Progress | None,
    layer_workers: int | None,
) -> Iterator[tuple[int, LayerRaster]]:
    total = prepared.layer_count
    workers = _resolve_layer_workers(layer_workers, total)
    interval = _progress_interval(total)

    if workers <= 1:
        for layer_index in range(total):
            if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
                progress(f"writing layer {layer_index + 1}/{total}")
            yield _render_layer(prepared, config, supports_enabled, support_plan, layer_index)
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
                    prepared,
                    config,
                    supports_enabled,
                    support_plan,
                    next_submit,
                )
                next_submit += 1

            layer_index, layer = futures.pop(next_yield).result()
            if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
                progress(f"writing layer {layer_index + 1}/{total}")
            next_yield += 1
            yield layer_index, layer


def _render_layer(
    prepared: PreparedMesh,
    config: PrintConfig,
    supports_enabled: bool,
    support_plan: SupportPlan,
    layer_index: int,
) -> tuple[int, LayerRaster]:
    layer = render_prepared_layer(prepared, config, layer_index)
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
