import unittest

from resin_slicer.formats import ctb, goo
from resin_slicer.raster import Run


class RleTests(unittest.TestCase):
    def test_goo_round_trip_runs(self) -> None:
        runs = [Run(12, 0), Run(300, 255), Run(1, 128), Run(20, 130), Run(7, 0)]
        encoded = goo.encode_rle(runs)
        decoded = goo.decode_rle(encoded)
        self.assertEqual(decoded, runs)

    def test_ctb_round_trip_runs(self) -> None:
        runs = [Run(1, 0), Run(127, 255), Run(128, 0), Run(20_000, 255), Run(3, 17)]
        encoded = ctb.encode_rle(runs)
        decoded = ctb.decode_rle(encoded)
        self.assertEqual(decoded, runs)


if __name__ == "__main__":
    unittest.main()
