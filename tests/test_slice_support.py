import unittest

from resin_slicer.config import SupportConfig, profile
from resin_slicer.electron_bridge import _support_from_request
from resin_slicer.mesh import Mesh, cube_mesh
from resin_slicer.raster import LayerRaster
from resin_slicer.slicing import prepare_mesh, render_model_layer
from resin_slicer.supports import (
    PaintZone,
    _SurfaceNormalSampler,
    _support_angle_deg,
    _support_radius_at_layer,
    apply_supports,
    attach_raft_masks,
    plan_supports,
    plan_supports_verified,
)


class SliceSupportTests(unittest.TestCase):
    def test_cube_slices_to_non_empty_layers(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8), config)
        counts = [render_model_layer(prepared.mesh, config, i).count_on() for i in range(prepared.layer_count)]
        self.assertEqual(prepared.layer_count, 8)
        self.assertTrue(all(count > 0 for count in counts))

    def test_overlapping_bodies_fill_their_union_not_even_odd(self) -> None:
        # Two overlapping, non-boolean-unioned solids (e.g. a multi-body CAD
        # export flattened to one STL) must fill the union of both bodies.
        # An even-odd fill rule would cancel the overlap and leave it hollow.
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        cube_a = cube_mesh(10)
        cube_b = cube_mesh(10).transformed((6, 0, 0))
        combined = Mesh(cube_a.triangles + cube_b.triangles)
        prepared = prepare_mesh(combined, config)
        mid_layer = prepared.layer_count // 2
        raster = render_model_layer(prepared.mesh, config, mid_layer)

        y_mid = config.resolution_y // 2
        row = raster.pixels[y_mid * raster.width : (y_mid + 1) * raster.width]
        on_xs = [x for x, value in enumerate(row) if value]
        gaps = [b - a for a, b in zip(on_xs, on_xs[1:]) if b - a > 1]
        self.assertEqual(gaps, [], "overlap region between the two bodies must stay filled")

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

    def test_attach_raft_masks_matches_full_plan(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        support = SupportConfig(enabled=True, model_lift_mm=4.0, support_spacing_mm=4.0, bed_interface="raft")
        prepared = prepare_mesh(cube_mesh(8), config, z_offset_mm=support.model_lift_mm)

        full = plan_supports(prepared, config, support, prepared.layer_count)
        bare = plan_supports(prepared, config, support, prepared.layer_count, include_raft_mask=False)
        self.assertIsNone(bare.raft_mask)

        attached = attach_raft_masks(bare, prepared, config, support)
        self.assertEqual(attached, full)

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

    def test_manual_only_routes_just_the_manual_points(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        bounds = prepared.mesh.bounds()
        click = ((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, bounds.min_z + 0.5)

        # Auto analysis would normally place several anchors; manual_only skips it
        # and routes only the supplied point.
        auto = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(auto.anchors), 1)

        manual_only = plan_supports(
            prepared, config, support, prepared.layer_count, manual_points=(click,), manual_only=True
        )
        self.assertEqual(len(manual_only.anchors), 1)
        self.assertTrue(all(anchor.role == "manual" for anchor in manual_only.anchors))
        self.assertEqual(len(manual_only.braces), 0)
        self.assertEqual(manual_only.anchors[0].base_layer, 0)

    def test_manual_only_slice_plans_only_manual_supports(self) -> None:
        import tempfile
        from pathlib import Path

        from resin_slicer.pipeline import SliceJob, slice_to_file

        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        mesh = cube_mesh(8).transformed((20, 10, 0))
        click = (24.0, 14.0, support.model_lift_mm + 0.5)
        with tempfile.TemporaryDirectory() as tmp:
            manual_only = slice_to_file(
                SliceJob(
                    mesh=mesh,
                    print_config=config,
                    support_config=support,
                    preserve_coordinates=True,
                    manual_support_points=(click,),
                    manual_support_only=True,
                ),
                Path(tmp) / "manual.goo",
                "goo",
            )
            full = slice_to_file(
                SliceJob(
                    mesh=mesh,
                    print_config=config,
                    support_config=support,
                    preserve_coordinates=True,
                    manual_support_points=(click,),
                ),
                Path(tmp) / "full.goo",
                "goo",
            )
        # Manual-only slicing must not invent automatic supports.
        self.assertEqual(manual_only.support_count, 1)
        self.assertGreater(full.support_count, 1)

    def test_manual_only_braces_between_manual_points(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(
            enabled=True,
            support_spacing_mm=4.0,
            min_island_area_mm2=0.01,
            brace_enabled=True,
            brace_max_distance_mm=8.0,
        )
        bounds = prepared.mesh.bounds()
        z = bounds.min_z + 0.5
        clicks = ((22.0, 14.0, z), (26.0, 14.0, z))
        plan = plan_supports(
            prepared, config, support, prepared.layer_count, manual_points=clicks, manual_only=True
        )
        self.assertEqual(len(plan.anchors), 2)
        self.assertGreater(len(plan.braces), 0)

    def test_paint_exclude_zone_blocks_auto_supports(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)

        base = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(base.anchors), 0)

        # A brush sphere big enough to cover the whole part removes every
        # automatic anchor.
        everything = (PaintZone(24.0, 14.0, 6.0, 50.0, "exclude"),)
        blocked = plan_supports(prepared, config, support, prepared.layer_count, paint_zones=everything)
        self.assertEqual(len(blocked.anchors), 0)

        # A zone far away from the model changes nothing.
        far_away = (PaintZone(70.0, 40.0, 30.0, 3.0, "exclude"),)
        unaffected = plan_supports(prepared, config, support, prepared.layer_count, paint_zones=far_away)
        self.assertEqual(len(unaffected.anchors), len(base.anchors))

    def test_paint_exclude_zone_does_not_block_manual_points(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        bounds = prepared.mesh.bounds()
        click = ((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, bounds.min_z + 0.5)
        everything = (PaintZone(24.0, 14.0, 6.0, 50.0, "exclude"),)

        plan = plan_supports(
            prepared, config, support, prepared.layer_count, manual_points=(click,), paint_zones=everything
        )
        self.assertEqual(len(plan.anchors), 1)
        self.assertEqual(plan.anchors[0].role, "manual")

    def test_paint_require_zones_route_spaced_anchors(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        # A dense stroke of brush samples along the bottom face.
        stroke = tuple(PaintZone(20.5 + i * 0.5, 14.0, 6.2, 2.0, "require") for i in range(16))

        plan = plan_supports(
            prepared, config, support, prepared.layer_count, manual_only=True, paint_zones=stroke
        )
        painted = [anchor for anchor in plan.anchors if anchor.role == "painted"]
        self.assertGreater(len(painted), 0)
        # The stroke is thinned to the configured support spacing, so far fewer
        # anchors than brush samples are placed.
        self.assertLess(len(painted), len(stroke))
        for i, first in enumerate(painted):
            for second in painted[i + 1 :]:
                dx_mm = (first.x - second.x) * config.pixel_size_x_mm
                dy_mm = (first.y - second.y) * config.pixel_size_y_mm
                distance = (dx_mm * dx_mm + dy_mm * dy_mm) ** 0.5
                self.assertGreaterEqual(distance, support.support_spacing_mm - config.pixel_size_x_mm)

    def test_brace_interval_repeats_braces_up_tall_supports(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8), config, z_offset_mm=20.0)
        common = dict(
            enabled=True,
            model_lift_mm=20.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            brace_enabled=True,
            brace_max_distance_mm=12.0,
            # Braces pair bed-routed trunks; tree merging would collapse this
            # small footprint to a single trunk and leave nothing to brace.
            tree_supports_enabled=False,
        )
        single = plan_supports(prepared, config, SupportConfig(**common), prepared.layer_count)
        repeated = plan_supports(
            prepared, config, SupportConfig(brace_interval_mm=4.0, **common), prepared.layer_count
        )

        self.assertGreater(len(single.braces), 0)
        self.assertEqual(len({brace.start_layer for brace in single.braces}), 1)
        levels = sorted({brace.start_layer for brace in repeated.braces})
        self.assertGreater(len(levels), 1)
        for earlier, later in zip(levels, levels[1:]):
            self.assertEqual(later - earlier, 4)
        self.assertGreater(len(repeated.braces), len(single.braces))
        # Every rung still stays below the joint of the supports it ties into.
        max_joint = max(
            anchor.joint_layer if anchor.joint_layer is not None else anchor.top_layer - 1
            for anchor in repeated.anchors
        )
        for brace in repeated.braces:
            self.assertLessEqual(brace.end_layer, max_joint)

    def test_braces_flatten_to_fit_short_supports(self) -> None:
        # At fine layer heights a full 45-degree diagonal cannot fit below the
        # joints of lift-height supports; the rung should slide down to the bed
        # interface and flatten instead of disappearing.
        config = profile("small-test").with_overrides(layer_height_mm=0.1)
        prepared = prepare_mesh(cube_mesh(10), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=4.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            brace_enabled=True,
            brace_height_mm=3.0,
            brace_max_distance_mm=8.0,
            tree_supports_enabled=False,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 1)
        self.assertGreater(len(plan.braces), 0)
        max_joint = max(
            anchor.joint_layer if anchor.joint_layer is not None else anchor.top_layer - 1
            for anchor in plan.anchors
        )
        for brace in plan.braces:
            self.assertGreater(brace.end_layer, brace.start_layer)
            self.assertLessEqual(brace.end_layer, max_joint)

    def test_higher_overhang_angle_generates_more_supports(self) -> None:
        # Exercises the raster sweep's angle threshold in isolation; mesh
        # minima are angle-independent and would mask the difference.
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
                mesh_minima_enabled=False,
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
                mesh_minima_enabled=False,
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
            # Bed-route avoidance is what this test checks; enforcer routes
            # terminate on the model on purpose and tree children lean, so keep
            # both out of the plan.
            enforcers_enabled=False,
            tree_supports_enabled=False,
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
            tree_supports_enabled=False,
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
            # Braces are 45-degree diagonals, flattened (down to a third of the
            # rise) only when short supports cannot fit the full diagonal.
            self.assertLessEqual(vertical_mm, horizontal_mm + config.layer_height_mm)
            self.assertGreaterEqual(vertical_mm, horizontal_mm / 3 - config.layer_height_mm)
            for layer_index in range(brace.start_layer, brace.end_layer + 1):
                layer = render_model_layer(prepared.mesh, config, layer_index)
                x, y = _brace_center_for_test(brace, layer_index)
                self.assertFalse(_disk_has_model(layer, x, y, plan.post_radius_px))

    def test_trunks_are_vertical_and_children_respect_lean_limit(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            max_support_angle_deg=35.0,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        for anchor in plan.anchors:
            base_x = anchor.base_x if anchor.base_x is not None else anchor.x
            base_y = anchor.base_y if anchor.base_y is not None else anchor.y
            joint_x = anchor.joint_x if anchor.joint_x is not None else anchor.x
            joint_y = anchor.joint_y if anchor.joint_y is not None else anchor.y
            if anchor.kind == "tree":
                # Merged shafts lean, but never beyond the configured angle.
                self.assertGreater(anchor.base_layer, 0)
                self.assertLessEqual(_support_angle_deg(anchor, config), support.max_support_angle_deg + 0.01)
            else:
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

    def test_vertical_contact_normal_keeps_bed_routes_vertical(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_offset_stack_mesh(), config, z_offset_mm=4.0)
        common = dict(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            enforcer_reach_mm=12.0,
            enforcer_min_drop_mm=1.0,
            # Minima candidates over the lower solid would become enforcer
            # routes; this test compares pure island/bed routing candidate
            # for candidate, so density boosts stay off too.
            mesh_minima_enabled=False,
            tree_supports_enabled=False,
            peel_density_enabled=False,
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

    def test_verified_plan_reports_no_islands_on_supported_model(self) -> None:
        # Adversarial for the verifier: braces, sphere tips, and a skate
        # interface all stamp extra geometry that must not be misread as
        # floating islands.
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            tip_type="sphere",
            bed_interface="skate",
            brace_enabled=True,
            brace_max_distance_mm=12.0,
        )
        plan, report = plan_supports_verified(prepared, config, support, prepared.layer_count)
        self.assertGreater(len(plan.anchors), 0)
        self.assertTrue(report.verified)
        self.assertEqual(report.residual_islands, ())
        self.assertEqual(report.failed_routes, 0)

    def test_verification_rescues_island_dropped_by_spacing(self) -> None:
        # Two small floating islands closer together than the support spacing:
        # the second island's candidates are all thinned away against the first
        # island's anchor, leaving it with no support at all. The closed-loop
        # verification must catch that and add a rescue support.
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        mesh = Mesh(tuple(_translated_cube(3, (0, 0, 0)) + _translated_cube(3, (5, 0, 0))))
        prepared = prepare_mesh(mesh, config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=6.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=45,
            brace_enabled=False,
            # Mesh minima would support the second island directly; this test
            # exercises the rescue path for spacing-dropped islands.
            mesh_minima_enabled=False,
        )
        plain = plan_supports(prepared, config, support, prepared.layer_count)
        plan, report = plan_supports_verified(prepared, config, support, prepared.layer_count)
        self.assertTrue(report.verified)
        self.assertGreater(report.rescue_count, 0)
        self.assertEqual(report.residual_islands, ())
        self.assertGreater(len(plan.anchors), len(plain.anchors))
        rescues = [anchor for anchor in plan.anchors if anchor.role == "rescue"]
        self.assertEqual(len(rescues), report.rescue_count)

    def test_verification_reports_residual_islands_when_unroutable(self) -> None:
        # An overhang directly above a wider solid: without enforcers no route
        # to the bed exists, so the region stays unsupported. The report must
        # say so instead of the plan silently omitting supports.
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_stacked_gap_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            enforcers_enabled=False,
        )
        _plan, report = plan_supports_verified(prepared, config, support, prepared.layer_count)
        self.assertTrue(report.verified)
        self.assertGreater(report.failed_routes, 0)
        self.assertGreater(len(report.residual_islands), 0)
        island = report.residual_islands[0]
        self.assertGreater(island.area_mm2, 0)

        # With enforcers (the default) the same geometry routes onto the lower
        # solid and verification comes back clean.
        with_enforcers = SupportConfig(
            enabled=True,
            model_lift_mm=4.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
        )
        plan2, report2 = plan_supports_verified(prepared, config, with_enforcers, prepared.layer_count)
        self.assertTrue(any(anchor.kind == "enforcer" for anchor in plan2.anchors))
        self.assertEqual(report2.residual_islands, ())

    def test_mesh_minima_support_downward_tip_at_apex(self) -> None:
        # An inverted pyramid: the apex is the first point to print but is far
        # smaller than an analysis pixel, so the raster sweep sees the island
        # late and off-centre. Minima detection must put a tip right on it.
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_inverted_pyramid_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=3.0,
            min_island_area_mm2=0.08,
            overhang_angle_deg=45,
        )
        plan, report = plan_supports_verified(prepared, config, support, prepared.layer_count)
        minima = [anchor for anchor in plan.anchors if anchor.role == "minima"]
        self.assertEqual(len(minima), 1)
        self.assertEqual(report.residual_islands, ())

        bounds = prepared.mesh.bounds()
        apex_x = (bounds.min_x + bounds.max_x) / 2
        apex_y = (bounds.min_y + bounds.max_y) / 2
        anchor = minima[0]
        self.assertAlmostEqual((anchor.x + 0.5) * config.pixel_size_x_mm, apex_x, delta=config.pixel_size_x_mm * 1.5)
        self.assertAlmostEqual((anchor.y + 0.5) * config.pixel_size_y_mm, apex_y, delta=config.pixel_size_y_mm * 1.5)
        # The tip contacts at (or immediately around) the apex layer, never later
        # than the earliest raster-detected contact.
        apex_layer = int(round(bounds.min_z / config.layer_height_mm - 0.5))
        self.assertLessEqual(abs(anchor.top_layer - apex_layer), 1)

        without = plan_supports(
            prepared,
            config,
            SupportConfig(
                enabled=True,
                model_lift_mm=5.0,
                support_spacing_mm=3.0,
                min_island_area_mm2=0.08,
                overhang_angle_deg=45,
                mesh_minima_enabled=False,
            ),
            prepared.layer_count,
        )
        self.assertTrue(all(anchor.role != "minima" for anchor in without.anchors))
        self.assertLessEqual(
            min(anchor.top_layer for anchor in plan.anchors),
            min(anchor.top_layer for anchor in without.anchors),
        )

    def test_mesh_minima_skip_plate_level_bottoms(self) -> None:
        # A cube sitting on the plate has all its minima at layer 0; the plate
        # supports them, so no minima anchors should appear.
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8), config)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        self.assertTrue(all(anchor.role != "minima" for anchor in plan.anchors))

    def test_mesh_minima_support_rotated_cube_corner(self) -> None:
        from resin_slicer.transform import MeshTransform, apply_transform

        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        mesh = apply_transform(cube_mesh(20), MeshTransform(rotate_x_deg=45, rotate_y_deg=45))
        prepared = prepare_mesh(mesh, config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=3.0,
            min_island_area_mm2=0.08,
            overhang_angle_deg=45,
        )
        plan, report = plan_supports_verified(prepared, config, support, prepared.layer_count)
        minima = [anchor for anchor in plan.anchors if anchor.role == "minima"]
        self.assertGreater(len(minima), 0)
        self.assertEqual(report.residual_islands, ())
        # The lowest corner of the tilted cube carries one of the minima tips.
        bounds = prepared.mesh.bounds()
        lowest_layer = int(round(bounds.min_z / config.layer_height_mm - 0.5))
        self.assertLessEqual(min(anchor.top_layer for anchor in minima), lowest_layer + 1)

    def test_tree_supports_merge_into_shared_trunks(self) -> None:
        # A tall lifted cube: many same-height contacts should merge into a few
        # trunks, with children leaning within the angle limit and the trunks
        # recording the load they carry.
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(cube_mesh(10), config, z_offset_mm=10.0)
        common = dict(
            enabled=True,
            model_lift_mm=10.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            brace_enabled=False,
        )
        plan, report = plan_supports_verified(
            prepared, config, SupportConfig(**common), prepared.layer_count
        )
        trees = [anchor for anchor in plan.anchors if anchor.kind == "tree"]
        trunks = [anchor for anchor in plan.anchors if anchor.kind == "bed" and anchor.base_layer == 0]
        self.assertGreater(len(trees), 0)
        self.assertLess(len(trunks), len(plan.anchors))
        self.assertEqual(report.residual_islands, ())
        self.assertTrue(any(anchor.load > 1 for anchor in trunks))
        for child in trees:
            self.assertGreater(child.base_layer, 0)
            self.assertLessEqual(_support_angle_deg(child, config), 35.01)

        # Disabling trees keeps every support as its own pillar.
        plain = plan_supports(
            prepared,
            config,
            SupportConfig(tree_supports_enabled=False, **common),
            prepared.layer_count,
        )
        self.assertTrue(all(anchor.kind != "tree" for anchor in plain.anchors))
        self.assertTrue(all(anchor.base_layer == 0 for anchor in plain.anchors))
        self.assertTrue(all(anchor.load == 1 for anchor in plain.anchors))

    def test_tree_children_do_not_clip_the_model(self) -> None:
        from resin_slicer.supports import _support_center

        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(_ledge_mesh(), config, z_offset_mm=5.0)
        support = SupportConfig(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=70,
            brace_enabled=False,
        )
        plan = plan_supports(prepared, config, support, prepared.layer_count)
        trees = [anchor for anchor in plan.anchors if anchor.kind == "tree"]
        self.assertGreater(len(trees), 0)
        for anchor in trees:
            joint_layer = anchor.joint_layer if anchor.joint_layer is not None else max(0, anchor.top_layer - 1)
            for layer_index in range(anchor.base_layer, joint_layer + 1):
                layer = render_model_layer(prepared.mesh, config, layer_index)
                x, y = _support_center(anchor, layer_index)
                self.assertFalse(_disk_has_model(layer, x, y, plan.post_radius_px))

    def test_trunk_radius_solver_follows_stress_budget(self) -> None:
        from resin_slicer.supports import _trunk_capacity_ok, _trunk_radius_scale

        r0, alpha = 0.28, 8.0
        self.assertEqual(_trunk_radius_scale(1, 0.0, r0, alpha), 1.0)
        # Balanced trunks stay thin: the axial-only radius sqrt(tips/alpha)
        # is below the 1x floor for small tip counts (sub-linear area).
        self.assertEqual(_trunk_radius_scale(4, 0.0, r0, alpha), 1.0)
        self.assertAlmostEqual(_trunk_radius_scale(32, 0.0, r0, alpha), 2.0)
        # Net moment buys thickness, monotonically.
        low = _trunk_radius_scale(2, 1.0, r0, alpha)
        high = _trunk_radius_scale(2, 5.0, r0, alpha)
        self.assertGreater(low, 1.0)
        self.assertGreater(high, low)
        # The solved radius satisfies the budget: tips/rho^2 + 4E/(r0 rho^3) <= alpha.
        for tips, moment in ((2, 1.0), (3, 2.0), (6, 1.5)):
            rho = _trunk_radius_scale(tips, moment, r0, alpha)
            if rho < 2.0:
                self.assertLessEqual(tips / rho**2 + 4 * moment / (r0 * rho**3), alpha + 1e-6)
        # Saturation: a far one-sided child exceeds what the radius cap carries.
        self.assertTrue(_trunk_capacity_ok(2, 1.0, r0, alpha))
        self.assertFalse(_trunk_capacity_ok(2, 6.0, r0, alpha))

    def test_trunk_taper_steps_down_above_junctions(self) -> None:
        from resin_slicer.supports import SupportAnchor, build_support_plan

        # Fine pixels so the taper is visible in integer radii.
        config = profile("generic-2k")
        support = SupportConfig(enabled=True)
        trunk = SupportAnchor(
            x=500, y=400, top_layer=30,
            base_x=500, base_y=400, base_layer=0,
            joint_x=500, joint_y=400, joint_layer=28,
            load=3,
            junctions=((6, 4.0, 0.0), (14, 1.0, 0.0)),
        )
        plan = build_support_plan((trunk,), (), config, support)
        r_base = _support_radius_at_layer(trunk, 2, plan)
        r_mid = _support_radius_at_layer(trunk, 10, plan)
        r_top = _support_radius_at_layer(trunk, 20, plan)
        self.assertGreater(r_base, r_mid)
        self.assertGreater(r_mid, r_top)
        self.assertEqual(r_top, plan.post_radius_px)

    def test_tree_supports_use_less_shaft_material(self) -> None:
        # Fine pixels (generic-2k) so trunk radii resolve honestly, and a flat
        # lifted cube so contacts form a grid the merge pass can balance.
        config = profile("generic-2k").with_overrides(layer_height_mm=0.5)
        prepared = prepare_mesh(cube_mesh(10), config, z_offset_mm=10.0)
        common = dict(
            enabled=True,
            model_lift_mm=10.0,
            support_spacing_mm=2.5,
            min_island_area_mm2=0.05,
            brace_enabled=False,
        )

        def shaft_volume(plan):
            # Sum of stamped disk areas (px^2) over every shaft layer: the
            # honest rasterised material, radius scaling included.
            total = 0
            for anchor in plan.anchors:
                joint = anchor.joint_layer if anchor.joint_layer is not None else anchor.top_layer - 1
                for layer in range(anchor.base_layer, joint + 1):
                    radius = _support_radius_at_layer(anchor, layer, plan)
                    total += radius * radius
            return total

        trees = plan_supports(prepared, config, SupportConfig(**common), prepared.layer_count)
        pillars = plan_supports(
            prepared, config, SupportConfig(tree_supports_enabled=False, **common), prepared.layer_count
        )
        self.assertGreater(len([a for a in trees.anchors if a.kind == "tree"]), 0)
        self.assertLess(shaft_volume(trees), shaft_volume(pillars))

    def test_tree_fallback_supports_unroutable_contacts(self) -> None:
        # A floating cube above a slab cannot route straight down (enforcers
        # off), but can lean onto the pillars of its neighbour that floats
        # beyond the slab's edge. Straight-only planning must leave a residual
        # island there; the tree fallback must not. The slab sits directly on
        # the plate and is paint-excluded so it contributes no anchors of its
        # own to the scenario.
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        triangles = (
            _translated_cube(4, (0, 0, 0))       # slab on the plate, z 0..4
            + _translated_cube(2, (1, 1, 10))    # floating cube above the slab
            + _translated_cube(2, (4.5, 1, 10))  # floating cube beyond the slab edge
        )
        prepared = prepare_mesh(Mesh(tuple(triangles)), config, z_offset_mm=0.0)
        bounds = prepared.mesh.bounds()
        slab_zone = (PaintZone(bounds.min_x + 2.0, bounds.min_y + 2.0, bounds.min_z + 2.0, 4.0, "exclude"),)
        common = dict(
            enabled=True,
            model_lift_mm=0.0,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            overhang_angle_deg=45,
            enforcers_enabled=False,
            brace_enabled=False,
        )
        plan, report = plan_supports_verified(
            prepared, config, SupportConfig(**common), prepared.layer_count, paint_zones=slab_zone
        )
        self.assertTrue(any(anchor.kind == "tree" for anchor in plan.anchors))
        self.assertEqual(report.residual_islands, ())

        _plain, report_plain = plan_supports_verified(
            prepared,
            config,
            SupportConfig(tree_supports_enabled=False, **common),
            prepared.layer_count,
            paint_zones=slab_zone,
        )
        self.assertGreater(len(report_plain.residual_islands), 0)

    def test_peel_density_tightens_spacing_on_large_flat_islands(self) -> None:
        # A big flat underside sees the highest peel forces; with peel density
        # on it must receive more supports than uniform spacing would place.
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(12), config, z_offset_mm=5.0)
        common = dict(
            enabled=True,
            model_lift_mm=5.0,
            support_spacing_mm=3.0,
            min_island_area_mm2=0.01,
            brace_enabled=False,
        )
        boosted = plan_supports(prepared, config, SupportConfig(**common), prepared.layer_count)
        uniform = plan_supports(
            prepared, config, SupportConfig(peel_density_enabled=False, **common), prepared.layer_count
        )
        self.assertGreater(len(boosted.anchors), len(uniform.anchors))

    def test_suction_cup_detected_and_vented_shape_is_clear(self) -> None:
        # Four walls and a sealed top form a downward-opening cavity: each
        # peel pulls against the vacuum inside it. Without the top the cavity
        # vents upward and must not be reported.
        config = profile("small-test").with_overrides(layer_height_mm=0.5)
        walls = (
            _box(0, 0, 0, 1, 8, 8)
            + _box(7, 0, 0, 8, 8, 8)
            + _box(1, 0, 0, 7, 1, 8)
            + _box(1, 7, 0, 7, 8, 8)
        )
        top = _box(0, 0, 8, 8, 8, 9)
        support = SupportConfig(enabled=True, model_lift_mm=0.0, support_spacing_mm=3.0, min_island_area_mm2=0.01)

        sealed = prepare_mesh(Mesh(tuple(walls + top)), config, z_offset_mm=0.0)
        _plan, report = plan_supports_verified(sealed, config, support, sealed.layer_count)
        self.assertEqual(len(report.suction_cups), 1)
        cup = report.suction_cups[0]
        # Interior is 6x6mm, 8mm tall.
        self.assertGreater(cup.mouth_area_mm2, 20.0)
        self.assertLess(cup.mouth_area_mm2, 50.0)
        self.assertGreaterEqual(cup.height_mm, 6.0)
        self.assertGreater(cup.volume_mm3, 150.0)

        vented = prepare_mesh(Mesh(tuple(walls)), config, z_offset_mm=0.0)
        _plan2, report2 = plan_supports_verified(vented, config, support, vented.layer_count)
        self.assertEqual(report2.suction_cups, ())

        disabled = SupportConfig(
            enabled=True,
            model_lift_mm=0.0,
            support_spacing_mm=3.0,
            min_island_area_mm2=0.01,
            cup_detection_enabled=False,
        )
        _plan3, report3 = plan_supports_verified(sealed, config, disabled, sealed.layer_count)
        self.assertEqual(report3.suction_cups, ())

    def test_manual_supports_never_become_tree_children(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(cube_mesh(8).transformed((20, 10, 6)), config, preserve_coordinates=True)
        support = SupportConfig(enabled=True, support_spacing_mm=4.0, min_island_area_mm2=0.01)
        bounds = prepared.mesh.bounds()
        click = ((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, bounds.min_z + 0.5)
        plan = plan_supports(prepared, config, support, prepared.layer_count, manual_points=(click,))
        manual = [anchor for anchor in plan.anchors if anchor.role == "manual"]
        self.assertEqual(len(manual), 1)
        self.assertEqual(manual[0].kind, "bed")
        self.assertEqual(manual[0].base_layer, 0)

    def test_manual_only_skips_verification_but_reports_failures(self) -> None:
        config = profile("small-test").with_overrides(layer_height_mm=1.0)
        prepared = prepare_mesh(_stacked_gap_mesh(), config, z_offset_mm=4.0)
        support = SupportConfig(
            enabled=True,
            support_spacing_mm=2.0,
            min_island_area_mm2=0.01,
            enforcers_enabled=False,
        )
        # A manual click on the underside of the upper cube, above the lower
        # solid: unroutable without enforcers. The upper cube's bottom face sits
        # 14mm above the lower cube's base in _stacked_gap_mesh.
        bounds = prepared.mesh.bounds()
        click = ((bounds.min_x + bounds.max_x) / 2, (bounds.min_y + bounds.max_y) / 2, bounds.min_z + 14.5)
        plan, report = plan_supports_verified(
            prepared, config, support, prepared.layer_count, manual_points=(click,), manual_only=True
        )
        self.assertFalse(report.verified)
        self.assertEqual(report.residual_islands, ())
        self.assertEqual(len(plan.anchors), 0)
        self.assertEqual(report.failed_routes, 1)


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


def _box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> list:
    """A cuboid as 12 triangles."""
    v = (
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    )
    faces = (
        (0, 2, 1), (0, 3, 2),
        (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4),
        (2, 3, 7), (2, 7, 6),
        (1, 2, 6), (1, 6, 5),
        (3, 0, 4), (3, 4, 7),
    )
    return [tuple(v[i] for i in face) for face in faces]


def _inverted_pyramid_mesh(base: float = 8.0, height: float = 5.0) -> Mesh:
    """A square pyramid with the apex pointing down at z=0 and its base on top."""
    apex = (base / 2, base / 2, 0.0)
    corners = (
        (0.0, 0.0, height),
        (base, 0.0, height),
        (base, base, height),
        (0.0, base, height),
    )
    triangles = (
        (apex, corners[0], corners[1]),
        (apex, corners[1], corners[2]),
        (apex, corners[2], corners[3]),
        (apex, corners[3], corners[0]),
        (corners[0], corners[2], corners[1]),
        (corners[0], corners[3], corners[2]),
    )
    return Mesh(triangles)


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
