import struct
import unittest
import zlib

from resin_slicer.raster import LayerRaster


def decode_grayscale_png_rows(png: bytes) -> tuple[int, int, list[list[int]]]:
    cursor = 8
    width = 0
    height = 0
    idat = bytearray()
    while cursor < len(png):
        length = struct.unpack(">I", png[cursor : cursor + 4])[0]
        tag = png[cursor + 4 : cursor + 8]
        data = png[cursor + 8 : cursor + 8 + length]
        if tag == b"IHDR":
            width, height = struct.unpack(">II", data[:8])
        elif tag == b"IDAT":
            idat.extend(data)
        cursor += 12 + length

    raw = zlib.decompress(bytes(idat))
    rows = []
    stride = width + 1
    for y in range(height):
        offset = y * stride
        assert raw[offset] == 0
        rows.append(list(raw[offset + 1 : offset + stride]))
    return width, height, rows


class RasterPreviewTests(unittest.TestCase):
    def test_scaled_png_preserves_covered_pixels(self) -> None:
        layer = LayerRaster(4, 4)
        layer.set_span(1, 1, 1)

        width, height, rows = decode_grayscale_png_rows(layer.to_png_bytes(scale=2))

        self.assertEqual((width, height), (2, 2))
        self.assertEqual(rows[0][0], 255)
        self.assertEqual(rows[0][1], 0)

    def test_scaled_png_keeps_partial_edge_blocks(self) -> None:
        layer = LayerRaster(5, 3)
        layer.set_span(2, 4, 4)

        width, height, rows = decode_grayscale_png_rows(layer.to_png_bytes(scale=2))

        self.assertEqual((width, height), (3, 2))
        self.assertEqual(rows[1][2], 255)


if __name__ == "__main__":
    unittest.main()
