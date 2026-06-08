from __future__ import annotations

from dataclasses import dataclass
from math import radians
from pathlib import Path

from .config import PrintConfig
from .errors import MeshError
from .raster import LayerRaster
from .slicing import Segment, rasterize_segments
from .step import DEFAULT_ANGULAR_TOLERANCE, DEFAULT_LINEAR_TOLERANCE_MM, read_step_shape, step_to_mesh
from .transform import MeshTransform


@dataclass(frozen=True)
class CadSliceModel:
    path: str
    transform: MeshTransform = MeshTransform()


@dataclass(frozen=True)
class _PreparedCadShape:
    shape: object
    sample_step_mm: float


@dataclass(frozen=True)
class CadSliceSource:
    shapes: tuple[_PreparedCadShape, ...]

    def render_layer(self, layer_index: int, config: PrintConfig) -> LayerRaster:
        z = (layer_index + 0.5) * config.layer_height_mm
        segments: list[Segment] = []
        for item in self.shapes:
            segments.extend(_section_segments(item.shape, z, item.sample_step_mm))
        return rasterize_segments(segments, config)


def prepare_cad_slice_source(
    models: tuple[CadSliceModel, ...],
    *,
    z_offset_mm: float = 0.0,
    linear_tolerance_mm: float = DEFAULT_LINEAR_TOLERANCE_MM,
    angular_tolerance: float = DEFAULT_ANGULAR_TOLERANCE,
) -> CadSliceSource:
    prepared: list[_PreparedCadShape] = []
    sample_step = max(0.05, float(linear_tolerance_mm) * 4.0)
    for model in models:
        path = Path(model.path)
        if path.suffix.lower() not in {".stp", ".step"}:
            continue
        mesh = step_to_mesh(
            path,
            linear_tolerance_mm=linear_tolerance_mm,
            angular_tolerance=angular_tolerance,
        )
        bounds = mesh.bounds()
        origin = (
            (bounds.min_x + bounds.max_x) / 2.0,
            (bounds.min_y + bounds.max_y) / 2.0,
            (bounds.min_z + bounds.max_z) / 2.0,
        )
        shape = read_step_shape(path)
        shape = _apply_model_transform(shape, model.transform, origin, z_offset_mm)
        prepared.append(_PreparedCadShape(shape, sample_step))
    if not prepared:
        raise MeshError("B-rep slicing was requested, but no STEP/STP CAD models were available")
    return CadSliceSource(tuple(prepared))


def _apply_model_transform(shape, transform: MeshTransform, origin: tuple[float, float, float], z_offset_mm: float):
    transform.validate()
    result = shape
    if abs(transform.scale - 1.0) > 1e-12:
        result = _scaled_shape(result, origin, transform.scale)
    if abs(transform.rotate_x_deg) > 1e-12:
        result = _rotated_shape(result, origin, (1, 0, 0), transform.rotate_x_deg)
    if abs(transform.rotate_y_deg) > 1e-12:
        result = _rotated_shape(result, origin, (0, 1, 0), transform.rotate_y_deg)
    if abs(transform.rotate_z_deg) > 1e-12:
        result = _rotated_shape(result, origin, (0, 0, 1), transform.rotate_z_deg)
    return _translated_shape(
        result,
        transform.translate_x_mm,
        transform.translate_y_mm,
        transform.translate_z_mm + z_offset_mm,
    )


def _scaled_shape(shape, origin: tuple[float, float, float], scale: float):
    from OCP.gp import gp_Pnt, gp_Trsf

    trsf = gp_Trsf()
    trsf.SetScale(gp_Pnt(*origin), scale)
    return _transformed_shape(shape, trsf)


def _rotated_shape(shape, origin: tuple[float, float, float], axis: tuple[float, float, float], degrees: float):
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf

    trsf = gp_Trsf()
    trsf.SetRotation(gp_Ax1(gp_Pnt(*origin), gp_Dir(*axis)), radians(degrees))
    return _transformed_shape(shape, trsf)


def _translated_shape(shape, dx: float, dy: float, dz: float):
    from OCP.gp import gp_Trsf, gp_Vec

    trsf = gp_Trsf()
    trsf.SetTranslation(gp_Vec(dx, dy, dz))
    return _transformed_shape(shape, trsf)


def _transformed_shape(shape, trsf):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform

    builder = BRepBuilderAPI_Transform(shape, trsf, True)
    builder.Build()
    if not builder.IsDone():
        raise MeshError("OpenCascade could not transform STEP geometry")
    return builder.Shape()


def _section_segments(shape, z: float, sample_step_mm: float) -> list[Segment]:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    section = BRepAlgoAPI_Section(shape, gp_Pln(gp_Pnt(0, 0, z), gp_Dir(0, 0, 1)), False)
    section.ComputePCurveOn1(True)
    section.Approximation(True)
    section.Build()
    if not section.IsDone() or section.Shape().IsNull():
        return []

    segments: list[Segment] = []
    explorer = TopExp_Explorer(section.Shape(), TopAbs_EDGE)
    while explorer.More():
        edge = TopoDS.Edge_s(explorer.Current())
        points = _sample_edge(edge, sample_step_mm)
        for first, second in zip(points, points[1:]):
            if _distance2(first, second) > 1e-16:
                segments.append(((first[0], first[1]), (second[0], second[1])))
        explorer.Next()
    return segments


def _sample_edge(edge, sample_step_mm: float) -> list[tuple[float, float, float]]:
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_UniformAbscissa

    curve = BRepAdaptor_Curve(edge)
    first = curve.FirstParameter()
    last = curve.LastParameter()
    if not _finite_parameter(first) or not _finite_parameter(last) or first == last:
        return []
    try:
        sampler = GCPnts_UniformAbscissa(curve, max(0.01, sample_step_mm))
        if sampler.IsDone() and sampler.NbPoints() >= 2:
            return [_curve_point(curve, sampler.Parameter(index)) for index in range(1, sampler.NbPoints() + 1)]
    except Exception:
        pass
    steps = 16
    return [_curve_point(curve, first + (last - first) * index / steps) for index in range(steps + 1)]


def _curve_point(curve, parameter: float) -> tuple[float, float, float]:
    point = curve.Value(parameter)
    return (point.X(), point.Y(), point.Z())


def _finite_parameter(value: float) -> bool:
    return value == value and abs(value) < 1e100


def _distance2(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    dz = a[2] - b[2]
    return dx * dx + dy * dy + dz * dz
