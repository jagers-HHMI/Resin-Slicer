import unittest

from resin_slicer.config import SupportConfig, profile
from resin_slicer.electron_bridge import _support_from_request
from resin_slicer.mesh import Mesh, cube_mesh
from resin_slicer.raster import LayerRaster
from resin_slicer.slicing import prepare_mesh, render_model_layer
from resin_slicer.supports import _SurfaceNormalSampler, _support_angle_deg, _support_radius_at_layer, apply_supports, plan_supports


class SliceSupportTests(unittest.TestCase):
    def test_cube_slices_to_non_empty_layers(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8), config)
        counts = [render_model_layer(prepared.mesh, config, i).count_on() for i in range(prepared.layer_count)]
        self.assertEqual(prepared.layer_count, 8)
        self.assertTrue(all(count > 0 for count in counts))

    def test_preserve_coordinates_keeps_plate_position(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0, center_model=False)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 3)), config, preserve_coordinates=True)
        bounds = prepared.mesh.bounds()
        self.assertAlmostEqual(bounds.min_x, 20)
        self.assertAlmostEqual(bounds.min_y, 10)
        self.assertAlmostEqual(bounds.min_z, 3)
        self.assertAlmostEqual(bounds.max_x, 28)
        self.assertAlmostEqual(bounds.max_y, 18)
        self.assertAlmostEqual(bounds.max_z, 11)
        self.assertEqual(prepared.layer_count, 11)

    def test_supports_are_deterministic_and_add_pixels(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_ledge_mesh(), config)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        plan_a = plan_supports(prepared, config, support, prepared.layer_count)
        plan_b = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertEqual(plan_a, plan_b)
        self.assertGreater(len(plan_a.anchors), 0)

        layer = render_model_layer(prepared.mesh, config, 0)
        before = layer.count_on()
        apply_supports(layer, 0, plan_a)
        self.assertGreaterEqual(layer.count_on(), before)

    def test_supported_pipeline_lifts_plate_contact_model(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        support = SupportConfig(enabled=True, model_lift_mm=4.0, support_spacing_mm=4.0)
        prepared = prepare_mesh(cube_mesh(8), config, z_offset_mm=support.model_lift_mm)
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        self.assertGreater(prepared.layer_count, 8)

    def test_manual_point_adds_routed_anchor(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        # A cube lifted off the plate so a manual support has room to route down.
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        bounds = prepared.mesh.bounds()
        click = ((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, bounds.min_z + 0.5)

        base = plan_supports(prepared, config, support, prepared.layer_count)
        with_manual = plan_supports(prepared, config, support, prepared.layer_count, manual_points=(click,))

        manual_anchors = [anchor for anchor in with_manual.anchors if anchor.role == "manual"]
        self.assertEqual(len(with_manual.anchors), len(base.anchors) + len(manual_anchors))
        self.assertEqual(len(manual_anchors), 1)
        anchor = manual_anchors[0]
        # The routed anchor's tip lands at the clicked location and reaches the plate.
        self.assertAlmostEqual((anchor.x + 0.5) * config.pixel_size_x_mm, click[0], delta=config.pixel_size_x_mm * 2)
        self.assertAlmostEqual((anchor.y + 0.5) * config.pixel_size_y_mm, click[1], delta=config.pixel_size_y_mm * 2)
        self.assertEqual(anchor.base_layer, 0)

    def test_higher_overhang_angle_generates_more_supports(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=4.0)
        loose = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=4.0,
                support_spacing_mm=4.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=20,
            ),
            prepared.layer_count,
        )
        strict = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=4.0,
                support_spacing_mm=4.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(strict.anchors), len(loose.anchors))

    def test_preferred_45_degree_orientation_generates_supports(self) -> None:
        from resin_slicer.transform import MeshTransform, apply_transform

        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        mesh = apply_transform(cube_mesh(20), MeshTransform(rotate_x_deg=45, rotate_y_deg=45))
        prepared = prepare_mesh(mesh, config, z_offset_mm=5.0)
        for angle in (45, 65, 89):
            support = SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=3.0,
                min_island_area_mm2=0.08,
                overhang_angle_deg=angle,
            )
            plan = plan_supports(prepared, config, support, prepared.layer_count)
            self.assertGreater(len(plan.anchors), 0)

    def test_support_columns_do_not_pass_through_model_below(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_stacked_gap_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)

        for anchor in plan.anchors:
            base_x = anchor.base_x if anchor.base_x is not None else anchor.x
            base_y = anchor.base_y if anchor.base_y is not None else anchor.y
            joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
            for layer_index in range(joint_layer + 1):
                layer = render_model_layer(prepared.mesh, config, layer_index)
                x, y = _anchor_center(
                    base_x,
                    base_y,
                    anchor.joint_x if anchor.joint_x is not None else anchor.x,
                    anchor.joint_y if anchor.joint_y is not None else anchor.y,
                    layer_index,
                    joint_layer,
                )
                self.assertFalse(_disk_has_model(layer, x, y, plan.post_radius_px))

    def test_support_overhaul_options_create_braces(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            tip_type="sphere",
            tip_length_mm=0.6,
            bed_interface="skate",
            brace_enabled=True,
            brace_max_distance_mm=12.0,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 1)
        self.assertGreater(len(plan.braces), 0)
        self.assertEqual(plan.bed_interface, "skate")
        self.assertTrue(all(anchor.tip_type == "sphere" for anchor in plan.anchors))
        for brace in plan.braces:
            horizontal_mm = (
                ((brace.x1 - brace.x0) * config.pixel_size_x_mm) ** 2
                + ((brace.y1 - brace.y0) * config.pixel_size_y_mm) ** 2
            ) ** 0.5
            vertical_mm = (brace.end_layer - brace.start_layer) * config.layer_height_mm
            self.assertGreater(brace.end_layer, brace.start_layer)
            self.assertAlmostEqual(vertical_mm, horizontal_mm, delta=config.layer_height_mm)
            for layer_index in range(brace.start_layer, brace.end_layer + 1):
                layer = render_model_layer(prepared.mesh, config, layer_index)
                x, y = _brace_center_for_test(brace, layer_index)
                self.assertFalse(_disk_has_model(layer, x, y, plan.post_radius_px))

    def test_support_posts_are_vertical(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        for anchor in plan.anchors:
            base_x = anchor.base_x if anchor.base_x is not None else anchor.x
            base_y = anchor.base_y if anchor.base_y is not None else anchor.y
            joint_x = anchor.joint_x if anchor.joint_x is not None else anchor.x
            joint_y = anchor.joint_y if anchor.joint_y is not None else anchor.y
            self.assertEqual((base_x, base_y), (joint_x, joint_y))

    def test_surface_normal_sampler_ignores_misaligned_surfaces(self) -> None:
        downward = ((0.0, 0.0, 0.0), (0.0, 2.0, 0.0), (2.0, 0.0, 0.0))
        nearby_downward = ((0.2, 0.0, 0.05), (0.2, 2.0, 0.05), (2.2, 0.0, 0.05))
        vertical = ((0.0, 0.0, 0.0), (0.0, 0.0, 2.0), (0.0, 2.0, 0.0))
        sampler = _SurfaceNormalSampler((downward, nearby_downward, vertical))
        normal = sampler.normal_at_contact((0.5, 0.5, 0.0), (0.0, 0.0, -1.0))
        self.assertAlmostEqual(normal[0], 0.0, places=5)
        self.assertAlmostEqual(normal[1], 0.0, places=5)
        self.assertAlmostEqual(normal[2], -1.0, places=5)

    def test_bed_interface_thickness_controls_base_layers(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            bed_interface="raft",
            bed_interface_thickness_mm=1.25,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertEqual(plan.raft_layers, 3)

    def test_spacing_changes_support_density(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        dense = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=1.5,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        sparse = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=6.0,
                min_island_area_mm2=0.01,
                overhang_angle_deg=70,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(dense.anchors), len(sparse.anchors))

    def test_primary_supports_add_dense_island_attachments(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        common = dict(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=4.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        standard = plan_supports(prepared, config, SupportConfig(**common), prepared.layer_count)
        primary = plan_supports(
            prepared,
            config,
            SupportConfig(
                primary_supports_enabled=True,
                primary_density_multiplier=2.0,
                primary_area_radius_mm=4.0,
                primary_max_extra_per_island=8,
                **common,
            ),
            prepared.layer_count,
        )
        self.assertGreater(len(primary.anchors), len(standard.anchors))
        self.assertGreater(len([anchor for anchor in primary.anchors if anchor.role == "primary"]), 0)

    def test_sphere_tip_has_bulb_radius(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            tip_type="sphere",
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        anchor = next(anchor for anchor in plan.anchors if anchor.top_layer > (anchor.joint_layer or 0))
        joint_layer = anchor.joint_layer or 0
        radii = [_support_radius_at_layer(anchor, layer, plan) for layer in range(joint_layer + 1, anchor.top_layer + 1)]
        self.assertGreater(max(radii), max(plan.post_radius_px, plan.tip_radius_px))

    def test_bed_supports_respect_max_shaft_angle(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_offset_stack_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            max_support_angle_deg=10,
            enforcers_enabled=False,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        self.assertTrue(all(_support_angle_deg(anchor, config) <= 10.01 for anchor in plan.anchors))
        self.assertTrue(all(anchor.kind == "bed" for anchor in plan.anchors))

    def test_vertical_contact_normal_keeps_bed_routes_vertical(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_offset_stack_mesh(), config, z_offset_mm=4.0)
        common = dict(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            max_support_angle_deg=0,
            enforcer_reach_mm=12.0,
            enforcer_min_drop_mm=1.0,
        )
        without_enforcers = plan_supports(
            prepared,
            config,
            SupportConfig(enforcers_enabled=False, **common),
            prepared.layer_count,
        )
        with_enforcers = plan_supports(
            prepared,
            config,
            SupportConfig(enforcers_enabled=True, **common),
            prepared.layer_count,
        )
        self.assertGreater(len(without_enforcers.anchors), 0)
        self.assertEqual(len(with_enforcers.anchors), len(without_enforcers.anchors))
        self.assertTrue(all(anchor.kind == "bed" for anchor in with_enforcers.anchors))
        self.assertTrue(all(_support_angle_deg(anchor, config) <= 0.01 for anchor in with_enforcers.anchors))

    def test_spherical_contact_shape_adds_contact_bulb(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        base_support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            spherical_contact_enabled=False,
        )
        sphere_support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            spherical_contact_enabled=True,
            spherical_contact_diameter_mm=2.0,
            spherical_contact_inset_mm=0.1,
        )
        base_plan = plan_supports(prepared, config, base_support, prepared.layer_count)
        sphere_plan = plan_supports(prepared, config, sphere_support, prepared.layer_count)
        base_pixels = 0
        sphere_pixels = 0
        for layer_index in range(prepared.layer_count):
            base_layer = render_model_layer(prepared.mesh, config, layer_index)
            sphere_layer = render_model_layer(prepared.mesh, config, layer_index)
            apply_supports(base_layer, layer_index, base_plan)
            apply_supports(sphere_layer, layer_index, sphere_plan)
            base_pixels += base_layer.count_on()
            sphere_pixels += sphere_layer.count_on()
        self.assertGreater(sphere_pixels, base_pixels)

    def test_spherical_contact_inset_percent_maps_to_diameter_fraction(self) -> None:
        half_inset = _support_from_request(
            {"support": {"sphericalContactDiameter": 2.0, "sphericalContactInsetPercent": 50}}
        )
        deep_inset = _support_from_request(
            {"support": {"sphericalContactDiameter": 2.0, "sphericalContactInsetPercent": 95}}
        )
        self.assertAlmostEqual(half_inset.spherical_contact_inset_mm, 1.0)
        self.assertAlmostEqual(deep_inset.spherical_contact_inset_mm, 1.9)

    def test_projected_raft_offset_expands_model_shadow(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        common = dict(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            bed_interface="raft",
            bed_interface_thickness_mm=1.0,
        )
        base_plan = plan_supports(
            prepared,
            config,
            SupportConfig(raft_margin_mm=0.0, **common),
            prepared.layer_count,
        )
        offset_plan = plan_supports(
            prepared,
            config,
            SupportConfig(raft_margin_mm=1.5, **common),
            prepared.layer_count,
        )
        base_layer = LayerRaster(config.resolution_x, config.resolution_y)
        offset_layer = LayerRaster(config.resolution_x, config.resolution_y)
        apply_supports(base_layer, 0, base_plan)
        apply_supports(offset_layer, 0, offset_plan)

        self.assertGreater(base_layer.count_on(), 0)
        self.assertGreater(offset_layer.count_on(), base_layer.count_on())

    def test_raft_chamfer_expands_from_bottom_layer(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            bed_interface="raft",
            raft_margin_mm=2.5,
            raft_chamfer_width_mm=1.5,
            raft_chamfer_angle_deg=45,
            bed_interface_thickness_mm=3.0,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        bottom = LayerRaster(config.resolution_x, config.resolution_y)
        upper = LayerRaster(config.resolution_x, config.resolution_y)
        apply_supports(bottom, 0, plan)
        apply_supports(upper, min(plan.raft_layers - 1, 5), plan)

        self.assertGreater(bottom.count_on(), 0)
        self.assertGreater(upper.count_on(), bottom.count_on())


def _translated_cube(size: float, offset: tuple[float, float, float]) -> list:
    ox, oy, oz = offset
    return [
        tuple((x + ox, y + oy, z + oz) for x, y, z in tri)
        for tri in cube_mesh(size).triangles
    ]


def _ledge_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(6, (0, 0, 0)))
    triangles.extend(_translated_cube(10, (4, 0, 6)))
    return Mesh(tuple(triangles))


def _stacked_gap_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(12, (0, 0, 0)))
    triangles.extend(_translated_cube(8, (2, 2, 14)))
    return Mesh(tuple(triangles))


def _offset_stack_mesh() -> Mesh:
    triangles = []
    triangles.extend(_translated_cube(12, (0, 0, 0)))
    triangles.extend(_translated_cube(8, (6, 2, 14)))
    return Mesh(tuple(triangles))


def _disk_has_model(layer, x: int, y: int, radius: int) -> bool:
    radius = max(0, radius)
    radius2 = radius * radius
    for yy in range(max(0, y - radius), min(layer.height, y + radius + 1)):
        for xx in range(max(0, x - radius), min(layer.width, x + radius + 1)):
            if (xx - x) * (xx - x) + (yy - y) * (yy - y) <= radius2:
                if layer.pixels[yy * layer.width + xx]:
                    return True
    return False


def _anchor_center(base_x: int, base_y: int, top_x: int, top_y: int, layer_index: int, top_layer: int) -> tuple[int, int]:
    if top_layer <= 0:
        return top_x, top_y
    t = layer_index / top_layer
    return (
        round(base_x + (top_x - base_x) * t),
        round(base_y + (top_y - base_y) * t),
    )


def _brace_center_for_test(brace, layer_index: int) -> tuple[int, int]:
    if brace.end_layer <= brace.start_layer:
        return brace.x0, brace.y0
    t = (layer_index - brace.start_layer) / (brace.end_layer - brace.start_layer)
    return (
        round(brace.x0 + (brace.x1 - brace.x0) * t),
        round(brace.y0 + (brace.y1 - brace.y0) * t),
    )


if __name__ == "__main__":
    unittest.main()
