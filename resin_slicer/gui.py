from __future__ import annotations

import queue
import threading
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from .config import PROFILES, SupportConfig, profile
from .errors import SlicerError
from .mesh import load_mesh
from .pipeline import SliceJob, slice_to_file
from .transform import MeshTransform


@dataclass(frozen=True)
class GuiOptions:
    input_path: Path
    output_path: Path
    output_format: str
    profile_name: str
    resolution: str
    volume: str
    layer_height: float
    exposure: float
    bottom_exposure: float
    bottom_layers: int
    supports_enabled: bool
    support_spacing: float
    support_radius: float
    tip_radius: float
    foot_radius: float
    model_lift: float
    overhang_angle: float
    rotate_x: float
    rotate_y: float
    rotate_z: float
    scale: float
    center_model: bool


class SlicerGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Resin Slicer")
        self.geometry("760x700")
        self.minsize(720, 660)
        self._messages: queue.Queue[tuple[str, str]] = queue.Queue()
        self._worker: threading.Thread | None = None

        self.input_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.format_var = tk.StringVar(value="goo")
        self.profile_var = tk.StringVar(value="generic-2k")
        self.resolution_var = tk.StringVar()
        self.volume_var = tk.StringVar()
        self.layer_height_var = tk.StringVar()
        self.exposure_var = tk.StringVar()
        self.bottom_exposure_var = tk.StringVar()
        self.bottom_layers_var = tk.StringVar()
        self.supports_var = tk.BooleanVar(value=True)
        self.support_spacing_var = tk.StringVar(value="3.0")
        self.support_radius_var = tk.StringVar(value="0.28")
        self.tip_radius_var = tk.StringVar(value="0.18")
        self.foot_radius_var = tk.StringVar(value="0.8")
        self.model_lift_var = tk.StringVar(value="5.0")
        self.overhang_angle_var = tk.StringVar(value="45")
        self.rotate_x_var = tk.StringVar(value="0")
        self.rotate_y_var = tk.StringVar(value="0")
        self.rotate_z_var = tk.StringVar(value="0")
        self.scale_var = tk.StringVar(value="1.0")
        self.center_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Ready")

        self._build()
        self._load_profile_defaults()
        self.after(100, self._poll_messages)

    def _build(self) -> None:
        root = ttk.Frame(self, padding=12)
        root.pack(fill=tk.BOTH, expand=True)
        root.columnconfigure(0, weight=1)

        files = ttk.LabelFrame(root, text="Files", padding=10)
        files.grid(row=0, column=0, sticky="ew")
        files.columnconfigure(1, weight=1)
        self._file_row(files, 0, "Input Mesh", self.input_var, self._browse_input)
        self._file_row(files, 1, "Output", self.output_var, self._browse_output)
        ttk.Label(files, text="Format").grid(row=2, column=0, sticky="w", pady=(8, 0))
        ttk.Combobox(files, textvariable=self.format_var, values=["goo", "ctb"], state="readonly", width=8).grid(
            row=2, column=1, sticky="w", pady=(8, 0)
        )

        settings = ttk.LabelFrame(root, text="Printer", padding=10)
        settings.grid(row=1, column=0, sticky="ew", pady=(10, 0))
        for col in range(4):
            settings.columnconfigure(col, weight=1)
        ttk.Label(settings, text="Profile").grid(row=0, column=0, sticky="w")
        profile_box = ttk.Combobox(
            settings,
            textvariable=self.profile_var,
            values=sorted(PROFILES),
            state="readonly",
        )
        profile_box.grid(row=0, column=1, sticky="ew", padx=(6, 12))
        profile_box.bind("<<ComboboxSelected>>", lambda _event: self._load_profile_defaults())
        self._entry(settings, 0, 2, "Resolution", self.resolution_var)
        self._entry(settings, 1, 0, "Volume mm", self.volume_var)
        self._entry(settings, 1, 2, "Layer mm", self.layer_height_var)
        self._entry(settings, 2, 0, "Exposure s", self.exposure_var)
        self._entry(settings, 2, 2, "Bottom s", self.bottom_exposure_var)
        self._entry(settings, 3, 0, "Bottom layers", self.bottom_layers_var)

        transform = ttk.LabelFrame(root, text="Orientation", padding=10)
        transform.grid(row=2, column=0, sticky="ew", pady=(10, 0))
        for col in range(6):
            transform.columnconfigure(col, weight=1)
        self._entry(transform, 0, 0, "Rotate X", self.rotate_x_var)
        self._entry(transform, 0, 2, "Rotate Y", self.rotate_y_var)
        self._entry(transform, 0, 4, "Rotate Z", self.rotate_z_var)
        self._entry(transform, 1, 0, "Scale", self.scale_var)
        ttk.Checkbutton(transform, text="Center on build plate", variable=self.center_var).grid(
            row=1, column=2, columnspan=2, sticky="w", padx=(6, 12), pady=5
        )

        supports = ttk.LabelFrame(root, text="Supports", padding=10)
        supports.grid(row=3, column=0, sticky="ew", pady=(10, 0))
        for col in range(4):
            supports.columnconfigure(col, weight=1)
        ttk.Checkbutton(supports, text="Generate supports", variable=self.supports_var).grid(row=0, column=0, sticky="w")
        self._entry(supports, 0, 1, "Model lift", self.model_lift_var)
        self._entry(supports, 1, 0, "Post radius", self.support_radius_var)
        self._entry(supports, 1, 2, "Tip radius", self.tip_radius_var)
        self._entry(supports, 2, 0, "Foot radius", self.foot_radius_var)
        self._entry(supports, 2, 2, "Spacing", self.support_spacing_var)
        self._entry(supports, 3, 0, "Overhang angle", self.overhang_angle_var)

        output = ttk.LabelFrame(root, text="Run", padding=10)
        output.grid(row=4, column=0, sticky="nsew", pady=(10, 0))
        root.rowconfigure(4, weight=1)
        output.columnconfigure(0, weight=1)
        self.log = tk.Text(output, height=7, wrap="word")
        self.log.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(output, orient="vertical", command=self.log.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        self.log.configure(yscrollcommand=scrollbar.set)

        actions = ttk.Frame(root)
        actions.grid(row=5, column=0, sticky="ew", pady=(10, 0))
        actions.columnconfigure(0, weight=1)
        ttk.Label(actions, textvariable=self.status_var).grid(row=0, column=0, sticky="w")
        self.slice_button = ttk.Button(actions, text="Slice", command=self._start_slice)
        self.slice_button.grid(row=0, column=1, sticky="e")

    def _file_row(self, parent: ttk.Frame, row: int, label: str, var: tk.StringVar, command: object) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", pady=4)
        ttk.Entry(parent, textvariable=var).grid(row=row, column=1, sticky="ew", padx=(8, 8), pady=4)
        ttk.Button(parent, text="Browse", command=command).grid(row=row, column=2, sticky="e", pady=4)

    def _entry(self, parent: ttk.Frame, row: int, col: int, label: str, var: tk.StringVar) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=col, sticky="w", padx=(0, 6), pady=5)
        ttk.Entry(parent, textvariable=var, width=14).grid(row=row, column=col + 1, sticky="ew", padx=(0, 12), pady=5)

    def _load_profile_defaults(self) -> None:
        cfg = profile(self.profile_var.get())
        self.resolution_var.set(f"{cfg.resolution_x}x{cfg.resolution_y}")
        self.volume_var.set(f"{cfg.size_x_mm:g}x{cfg.size_y_mm:g}x{cfg.size_z_mm:g}")
        self.layer_height_var.set(f"{cfg.layer_height_mm:g}")
        self.exposure_var.set(f"{cfg.exposure_time_s:g}")
        self.bottom_exposure_var.set(f"{cfg.bottom_exposure_time_s:g}")
        self.bottom_layers_var.set(str(cfg.bottom_layers))

    def _browse_input(self) -> None:
        filename = filedialog.askopenfilename(
            filetypes=[("Mesh files", "*.stl *.obj"), ("STL files", "*.stl"), ("OBJ files", "*.obj"), ("All files", "*.*")]
        )
        if not filename:
            return
        self.input_var.set(filename)
        if not self.output_var.get():
            path = Path(filename).with_suffix("." + self.format_var.get())
            self.output_var.set(str(path))

    def _browse_output(self) -> None:
        fmt = self.format_var.get()
        filename = filedialog.asksaveasfilename(
            defaultextension="." + fmt,
            filetypes=[(fmt.upper() + " files", "*." + fmt), ("All files", "*.*")],
        )
        if filename:
            self.output_var.set(filename)

    def _start_slice(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        try:
            options = self._collect_options()
        except SlicerError as exc:
            messagebox.showerror("Invalid settings", str(exc))
            return

        self.log.delete("1.0", tk.END)
        self.slice_button.configure(state="disabled")
        self.status_var.set("Slicing...")
        self._worker = threading.Thread(target=self._slice_worker, args=(options,), daemon=True)
        self._worker.start()

    def _collect_options(self) -> GuiOptions:
        input_text = self.input_var.get().strip()
        output_text = self.output_var.get().strip()
        if not input_text:
            raise SlicerError("choose an input STL or OBJ file")
        if not output_text:
            raise SlicerError("choose an output file")
        return GuiOptions(
            input_path=Path(input_text),
            output_path=Path(output_text),
            output_format=self.format_var.get(),
            profile_name=self.profile_var.get(),
            resolution=self.resolution_var.get(),
            volume=self.volume_var.get(),
            layer_height=_float(self.layer_height_var.get(), "layer height"),
            exposure=_float(self.exposure_var.get(), "exposure"),
            bottom_exposure=_float(self.bottom_exposure_var.get(), "bottom exposure"),
            bottom_layers=_int(self.bottom_layers_var.get(), "bottom layers"),
            supports_enabled=self.supports_var.get(),
            support_spacing=_float(self.support_spacing_var.get(), "support spacing"),
            support_radius=_float(self.support_radius_var.get(), "support radius"),
            tip_radius=_float(self.tip_radius_var.get(), "tip radius"),
            foot_radius=_float(self.foot_radius_var.get(), "foot radius"),
            model_lift=_float(self.model_lift_var.get(), "model lift"),
            overhang_angle=_float(self.overhang_angle_var.get(), "overhang angle"),
            rotate_x=_float(self.rotate_x_var.get(), "rotate X"),
            rotate_y=_float(self.rotate_y_var.get(), "rotate Y"),
            rotate_z=_float(self.rotate_z_var.get(), "rotate Z"),
            scale=_float(self.scale_var.get(), "scale"),
            center_model=self.center_var.get(),
        )

    def _slice_worker(self, options: GuiOptions) -> None:
        try:
            cfg = profile(options.profile_name)
            resolution_x, resolution_y = _parse_pair(options.resolution, "resolution")
            size_x, size_y, size_z = _parse_triple(options.volume, "volume")
            cfg = cfg.with_overrides(
                resolution_x=int(resolution_x),
                resolution_y=int(resolution_y),
                size_x_mm=size_x,
                size_y_mm=size_y,
                size_z_mm=size_z,
                layer_height_mm=options.layer_height,
                exposure_time_s=options.exposure,
                bottom_exposure_time_s=options.bottom_exposure,
                bottom_layers=options.bottom_layers,
                center_model=options.center_model,
            )
            support = SupportConfig(
                enabled=options.supports_enabled,
                model_lift_mm=options.model_lift,
                overhang_angle_deg=options.overhang_angle,
                support_spacing_mm=options.support_spacing,
                post_radius_mm=options.support_radius,
                tip_radius_mm=options.tip_radius,
                foot_radius_mm=options.foot_radius,
            )
            transform = MeshTransform(
                rotate_x_deg=options.rotate_x,
                rotate_y_deg=options.rotate_y,
                rotate_z_deg=options.rotate_z,
                scale=options.scale,
            )
            self._messages.put(("progress", "loading mesh"))
            mesh = load_mesh(options.input_path)
            result = slice_to_file(
                SliceJob(mesh, cfg, support, transform),
                options.output_path,
                options.output_format,
                progress=lambda message: self._messages.put(("progress", message)),
            )
        except Exception as exc:
            self._messages.put(("error", str(exc)))
            return
        self._messages.put(
            (
                "done",
                f"wrote {result.output_path} ({result.layer_count} layers, "
                f"{result.support_count} supports, {result.material_ml:.2f} ml resin)",
            )
        )

    def _poll_messages(self) -> None:
        try:
            while True:
                kind, message = self._messages.get_nowait()
                if kind == "progress":
                    self._append_log(message)
                    self.status_var.set(message)
                elif kind == "error":
                    self._append_log("error: " + message)
                    self.status_var.set("Error")
                    self.slice_button.configure(state="normal")
                    messagebox.showerror("Slice failed", message)
                elif kind == "done":
                    self._append_log(message)
                    self.status_var.set("Done")
                    self.slice_button.configure(state="normal")
        except queue.Empty:
            pass
        self.after(100, self._poll_messages)

    def _append_log(self, message: str) -> None:
        self.log.insert(tk.END, message + "\n")
        self.log.see(tk.END)


def _float(value: str, label: str) -> float:
    try:
        return float(value)
    except ValueError as exc:
        raise SlicerError(f"{label} must be a number") from exc


def _int(value: str, label: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise SlicerError(f"{label} must be an integer") from exc


def _parse_pair(value: str, label: str) -> tuple[float, float]:
    parts = value.lower().split("x")
    if len(parts) != 2:
        raise SlicerError(f"{label} must be formatted as XxY")
    return float(parts[0]), float(parts[1])


def _parse_triple(value: str, label: str) -> tuple[float, float, float]:
    parts = value.lower().split("x")
    if len(parts) != 3:
        raise SlicerError(f"{label} must be formatted as XxYxZ")
    return float(parts[0]), float(parts[1]), float(parts[2])


def main() -> int:
    app = SlicerGui()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
