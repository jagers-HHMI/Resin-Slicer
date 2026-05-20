from __future__ import annotations

from .config import PrintConfig
from .raster import LayerRaster


def estimate_material_mm3(layer: LayerRaster, config: PrintConfig) -> float:
    return layer.count_on() * config.pixel_area_mm2 * config.layer_height_mm
