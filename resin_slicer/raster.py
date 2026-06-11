from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import ceil, floor, sqrt
from typing import Iterable

_BINARY_TRANSLATION = bytes(0 if value == 0 else 1 for value in range(256))


@dataclass(frozen=True)
class Run:
    length: int
    value: int


@dataclass(frozen=True)
class Component:
    pixels: tuple[int, ...]
    min_x: int
    min_y: int
    max_x: int
    max_y: int

    @property
    def area_px(self) -> int:
        return len(self.pixels)

    def centroid(self, width: int) -> tuple[float, float]:
        sx = 0
        sy = 0
        for index in self.pixels:
            sx += index % width
            sy += index // width
        n = max(1, len(self.pixels))
        return sx / n, sy / n


class LayerRaster:
    def __init__(self, width: int, height: int, pixels: bytearray | None = None) -> None:
        self.width = width
        self.height = height
        self.pixels = pixels if pixels is not None else bytearray(width * height)
        if len(self.pixels) != width * height:
            raise ValueError("pixel buffer length does not match layer dimensions")

    def copy(self) -> "LayerRaster":
        return LayerRaster(self.width, self.height, bytearray(self.pixels))

    def count_on(self) -> int:
        total = 0
        for start, end in self._nonzero_spans():
            total += end - start
        return total

    def set_span(self, y: int, x0: int, x1: int, value: int = 255) -> None:
        if y < 0 or y >= self.height:
            return
        x0 = max(0, x0)
        x1 = min(self.width - 1, x1)
        if x0 > x1:
            return
        start = y * self.width + x0
        self.pixels[start : start + x1 - x0 + 1] = bytes([value]) * (x1 - x0 + 1)

    def add_disk(self, cx: int, cy: int, radius: int, value: int = 255) -> None:
        radius = max(0, radius)
        r2 = radius * radius
        for y in range(max(0, cy - radius), min(self.height, cy + radius + 1)):
            dy2 = (y - cy) * (y - cy)
            dx = int(floor(sqrt(max(0, r2 - dy2))))
            self.set_span(y, cx - dx, cx + dx, value)

    def add_capsule(self, x0: int, y0: int, x1: int, y1: int, radius: int, value: int = 255) -> None:
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        previous: tuple[int, int] | None = None
        for step in range(steps + 1):
            t = step / steps
            x = int(round(x0 + (x1 - x0) * t))
            y = int(round(y0 + (y1 - y0) * t))
            if previous == (x, y):
                continue
            self.add_disk(x, y, radius, value)
            previous = (x, y)

    def or_with(self, other: "LayerRaster") -> None:
        if self.width != other.width or self.height != other.height:
            raise ValueError("cannot merge rasters with different dimensions")
        for i, value in enumerate(other.pixels):
            if value:
                self.pixels[i] = max(self.pixels[i], value)

    def runs(self) -> Iterable[Run]:
        total = self.width * self.height
        cursor = 0
        for start, end in self._nonzero_spans():
            if start > cursor:
                yield Run(start - cursor, 0)
            yield Run(end - start, 255)
            cursor = end
        if cursor < total:
            yield Run(total - cursor, 0)

    def nonzero_spans(self) -> Iterable[tuple[int, int]]:
        return self._nonzero_spans()

    def _nonzero_spans(self) -> Iterable[tuple[int, int]]:
        for y in range(self.height):
            row_start = y * self.width
            row_end = row_start + self.width
            row = self.pixels[row_start:row_end]
            x = row.find(255)
            while x != -1:
                span_end = row.find(0, x)
                if span_end == -1:
                    span_end = self.width
                yield row_start + x, row_start + span_end
                x = row.find(255, span_end)

    def unsupported_mask(self, support_mask: bytearray) -> bytearray:
        if len(support_mask) != len(self.pixels):
            raise ValueError("support mask length mismatch")
        out = bytearray(len(self.pixels))
        for y in range(self.height):
            row_start = y * self.width
            row_end = row_start + self.width
            model_row = self.pixels[row_start:row_end]
            support_row = support_mask[row_start:row_end]
            x = model_row.find(255)
            while x != -1:
                span_end = model_row.find(0, x)
                if span_end == -1:
                    span_end = self.width

                cursor = x
                while cursor < span_end:
                    unsupported_start = support_row.find(0, cursor, span_end)
                    if unsupported_start == -1:
                        break
                    unsupported_end = support_row.find(1, unsupported_start, span_end)
                    if unsupported_end == -1:
                        unsupported_end = span_end
                    out[row_start + unsupported_start : row_start + unsupported_end] = b"\x01" * (
                        unsupported_end - unsupported_start
                    )
                    cursor = unsupported_end

                x = model_row.find(255, span_end)
        return out

    def connected_components(self, active_mask: bytearray, min_area_px: int) -> list[Component]:
        width = self.width
        height = self.height
        visited = bytearray(len(active_mask))
        components: list[Component] = []
        start = active_mask.find(1)
        while start != -1:
            if visited[start]:
                start = active_mask.find(1, start + 1)
                continue
            queue: deque[int] = deque([start])
            visited[start] = 1
            pixels: list[int] = []
            min_x = max_x = start % width
            min_y = max_y = start // width
            while queue:
                index = queue.popleft()
                pixels.append(index)
                x = index % width
                y = index // width
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    nindex = ny * width + nx
                    if active_mask[nindex] and not visited[nindex]:
                        visited[nindex] = 1
                        queue.append(nindex)
            if len(pixels) >= min_area_px:
                components.append(Component(tuple(pixels), min_x, min_y, max_x, max_y))
            start = active_mask.find(1, start + 1)
        return components


    def to_png_bytes(self, scale: int = 1) -> bytes:
        import struct, zlib

        scale = max(1, int(scale))
        out_w = max(1, ceil(self.width / scale))
        out_h = max(1, ceil(self.height / scale))
        src = self.pixels
        src_w = self.width
        raw = bytearray(out_h * (out_w + 1))
        for py in range(out_h):
            row_off = py * (out_w + 1)
            raw[row_off] = 0
            y0 = py * scale
            y1 = min(self.height, y0 + scale)
            out_row_start = row_off + 1
            for sy in range(y0, y1):
                src_row_start = sy * src_w
                src_row_end = src_row_start + src_w
                span_start = src.find(255, src_row_start, src_row_end)
                while span_start != -1:
                    span_end = src.find(0, span_start, src_row_end)
                    if span_end == -1:
                        span_end = src_row_end
                    out_x0 = (span_start - src_row_start) // scale
                    out_x1 = (span_end - 1 - src_row_start) // scale
                    raw[out_row_start + out_x0 : out_row_start + out_x1 + 1] = b"\xff" * (out_x1 - out_x0 + 1)
                    span_start = src.find(255, span_end, src_row_end)
        compressed = zlib.compress(bytes(raw), 1)

        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", out_w, out_h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", compressed)
            + chunk(b"IEND", b"")
        )


def dilate_mask(layer: LayerRaster, radius: int) -> bytearray:
    width = layer.width
    height = layer.height
    if radius <= 0:
        return layer.pixels.translate(_BINARY_TRANSLATION)

    out = bytearray(width * height)
    for y in range(height):
        row_start = y * width
        row_end = row_start + width
        row = layer.pixels[row_start:row_end]
        x = row.find(255)
        while x != -1:
            span_end = row.find(0, x)
            if span_end == -1:
                span_end = width
            x0 = max(0, x - radius)
            x1 = min(width, span_end + radius)
            fill = b"\x01" * (x1 - x0)
            for yy in range(max(0, y - radius), min(height, y + radius + 1)):
                base = yy * width
                out[base + x0 : base + x1] = fill
            x = row.find(255, span_end)
    return out


def dilate_mask_dense(layer: LayerRaster, radius: int) -> bytearray:
    width = layer.width
    height = layer.height
    if radius <= 0:
        return layer.pixels.translate(_BINARY_TRANSLATION)

    horizontal = bytearray(width * height)
    for y in range(height):
        row_start = y * width
        prefix = [0] * (width + 1)
        for x in range(width):
            prefix[x + 1] = prefix[x] + (1 if layer.pixels[row_start + x] else 0)
        for x in range(width):
            left = max(0, x - radius)
            right = min(width, x + radius + 1)
            if prefix[right] - prefix[left] > 0:
                horizontal[row_start + x] = 1

    out = bytearray(width * height)
    counts = [0] * width
    for y in range(height):
        add_y = y + radius
        if add_y < height:
            base = add_y * width
            for x in range(width):
                counts[x] += horizontal[base + x]
        remove_y = y - radius - 1
        if remove_y >= 0:
            base = remove_y * width
            for x in range(width):
                counts[x] -= horizontal[base + x]
        base = y * width
        for x in range(width):
            if counts[x] > 0:
                out[base + x] = 1
    return out


def mm_to_px(mm: float, pixel_mm: float) -> int:
    return max(1, int(ceil(mm / pixel_mm)))
