import unittest

from resin_slicer.config import profile


class ConfigTests(unittest.TestCase):
    def test_jupiter_2_16k_profile_validates(self) -> None:
        config = profile("elegoo-jupiter-2-16k")

        self.assertEqual(config.resolution_x, 15120)
        self.assertEqual(config.resolution_y, 6230)
        self.assertEqual(config.resolution_x * config.resolution_y, 94_197_600)
        self.assertGreaterEqual(config.max_pixels_per_layer, config.resolution_x * config.resolution_y)

    def test_default_limit_allows_jupiter_2_16k_resolution_override(self) -> None:
        config = profile("generic-2k").with_overrides(
            resolution_x=15120,
            resolution_y=6230,
            size_x_mm=302.40,
            size_y_mm=161.98,
            size_z_mm=300.0,
        )

        self.assertEqual(config.max_pixels_per_layer, 100_000_000)


if __name__ == "__main__":
    unittest.main()
