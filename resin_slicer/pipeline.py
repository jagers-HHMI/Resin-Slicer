from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .config import PrintConfig, SupportConfig
from .errors import FormatError
from .formats.ctb import write_ctb
from .formats.goo import write_goo
from .mesh import Mesh
from .slicing import prepare_mesh, render_prepared_layer
from .supports import SupportPlan, apply_supports, plan_supports
from .transform import MeshTransform, apply_transform

Progress = Callable[[str], None]


@dataclass(frozen=True)
class SliceJob:
    mesh: Mesh
    print_config: PrintConfig
    support_config: SupportConfig = SupportConfig()
    transform: MeshTransform = MeshTransform()


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
    )
    output = Path(output_path)
    fmt = fmt.lower().lstrip(".")
    if fmt not in {"goo", "ctb"}:
        raise FormatError("output format must be 'goo' or 'ctb'")

    if progress:
        progress(f"prepared mesh: {prepared.layer_count} layers")

    support_plan = SupportPlan((), 0, 0, 0, 0)
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

    def layer_iter():
        interval = _progress_interval(prepared.layer_count)
        for layer_index in range(prepared.layer_count):
            if progress and (layer_index == 0 or (layer_index + 1) % interval == 0):
                progress(f"writing layer {layer_index + 1}/{prepared.layer_count}")
            layer = render_prepared_layer(prepared, config, layer_index)
            if support_config.enabled:
                apply_supports(layer, layer_index, support_plan)
            yield layer_index, layer

    if progress:
        progress(f"writing {fmt}")
    if fmt == "goo":
        stats = write_goo(output, config, prepared.layer_count, layer_iter())
    else:
        stats = write_ctb(output, config, prepared.layer_count, layer_iter())

    return SliceResult(
        layer_count=prepared.layer_count,
        support_count=len(support_plan.anchors),
        material_ml=stats.material_mm3 / 1000.0,
        output_path=output,
    )


def _progress_interval(total: int) -> int:
    return max(1, total // 20)
