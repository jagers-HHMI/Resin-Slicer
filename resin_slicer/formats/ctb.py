from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from ..config import PrintConfig
from ..material import estimate_material_mm3
from ..raster import LayerRaster, Run
from .aes import aes256_cbc_zero_encrypt
from .binary import ByteWriter, align

FORMAT_VERSION = 5
PAGE_SIZE = 1 << 32
DEFAULT_XOR_KEY = 0x67
DISCLAIMER = (
    "Layout and record format for the ctb and cbddlp file types are the copyrighted "
    "programs or codes of CBD Technology (China) Inc..The Customer or User shall not "
    "in any manner reproduce, distribute, modify, decompile, disassemble, decrypt, "
    "extract, reverse engineer, lease, assign, or sublicense the said programs or codes."
)

ENCRYPT_KEY = bytes(
    [
        0xD0, 0x5B, 0x8E, 0x33, 0x71, 0xDE, 0x3D, 0x1A,
        0xE5, 0x4F, 0x22, 0xDD, 0xDF, 0x5B, 0xFD, 0x94,
        0xAB, 0x5D, 0x64, 0x3A, 0x9D, 0x7E, 0xBF, 0xAF,
        0x42, 0x03, 0xF3, 0x10, 0xD8, 0x52, 0x2A, 0xEA,
    ]
)
ENCRYPT_IV = bytes(
    [
        0x0F, 0x01, 0x0A, 0x05, 0x05, 0x0B, 0x06, 0x07,
        0x08, 0x06, 0x0A, 0x0C, 0x0C, 0x0D, 0x09, 0x0F,
    ]
)


@dataclass(frozen=True)
class FormatStats:
    material_mm3: float


@dataclass(frozen=True)
class CtbLayer:
    position_z_mm: float
    exposure_s: float
    lift_height_mm: float
    lift_speed_mm_min: float
    retract_speed_mm_min: float
    rest_after_retract_s: float
    light_pwm: float
    data: bytes


def write_ctb(
    path: Path,
    config: PrintConfig,
    layer_count: int,
    layers: object,
) -> FormatStats:
    material = 0.0
    encoded_layers: list[CtbLayer] = []
    for layer_index, raster in layers:  # type: ignore[assignment]
        material += estimate_material_mm3(raster, config)
        encoded_layers.append(_encode_layer(layer_index, raster, config))

    writer = ByteWriter()
    _write_file(writer, config, encoded_layers, material)
    path.write_bytes(writer.data)
    return FormatStats(material)


def encode_rle(runs: object) -> bytes:
    out = bytearray()
    for run in runs:  # type: ignore[assignment]
        _add_run(out, run.length, run.value)
    return bytes(out)


def decode_rle(data: bytes) -> list[Run]:
    out: list[Run] = []
    offset = 0
    while offset < len(data):
        value = data[offset]
        length = 1
        if value & 0x80:
            value &= 0x7F
            offset += 1
            next_byte = data[offset]
            if next_byte & 0x80 == 0:
                length = next_byte
            elif next_byte & 0xC0 == 0x80:
                length = ((next_byte & 0x3F) << 8) + data[offset + 1]
                offset += 1
            elif next_byte & 0xE0 == 0xC0:
                length = ((next_byte & 0x1F) << 16) + (data[offset + 1] << 8) + data[offset + 2]
                offset += 2
            elif next_byte & 0xF0 == 0xE0:
                length = (
                    ((next_byte & 0x0F) << 24)
                    + (data[offset + 1] << 16)
                    + (data[offset + 2] << 8)
                    + data[offset + 3]
                )
                offset += 3
            else:
                raise ValueError("invalid CTB RLE length marker")
        offset += 1
        if value:
            value = ((value << 1) | 1) & 0xFF
        out.append(Run(length, value))
    return out


def _add_run(out: bytearray, length: int, value: int) -> None:
    if length <= 0:
        return
    while length > 0x0FFFFFFF:
        _add_run(out, 0x0FFFFFFF, value)
        length -= 0x0FFFFFFF
    out.append((value >> 1) | (0x80 if length > 1 else 0))
    if length <= 1:
        return
    if length <= 0x7F:
        out.append(length)
    elif length <= 0x3FFF:
        out.extend([(length >> 8) | 0x80, length & 0xFF])
    elif length <= 0x1FFFFF:
        out.extend([(length >> 16) | 0xC0, (length >> 8) & 0xFF, length & 0xFF])
    else:
        out.extend([(length >> 24) | 0xE0, (length >> 16) & 0xFF, (length >> 8) & 0xFF, length & 0xFF])


def _encode_layer(layer_index: int, raster: LayerRaster, config: PrintConfig) -> CtbLayer:
    bottom = layer_index < config.bottom_layers
    return CtbLayer(
        position_z_mm=config.layer_height_mm * (layer_index + 1),
        exposure_s=config.bottom_exposure_time_s if bottom else config.exposure_time_s,
        lift_height_mm=config.lift_distance_mm,
        lift_speed_mm_min=config.lift_speed_mm_min,
        retract_speed_mm_min=config.retract_speed_mm_min,
        rest_after_retract_s=config.wait_after_retract_s,
        light_pwm=float(config.bottom_light_pwm if bottom else config.light_pwm),
        data=encode_rle(raster.runs()),
    )


def _write_file(writer: ByteWriter, config: PrintConfig, layers: list[CtbLayer], material_mm3: float) -> None:
    checksum = 0
    writer.write_u32_le(0x12FD0107)
    settings_section = writer.reserve(8)
    writer.write_u32_le(0)
    writer.write_u32_le(FORMAT_VERSION)
    signature_section = writer.reserve(8)
    writer.write_u32_le(0)
    writer.write_u16_le(1)
    writer.write_u16_le(1)
    writer.write_u32_le(0)
    writer.write_u32_le(0x2A)
    writer.write_u32_le(0)

    settings_offset = writer.pos()
    settings = _build_settings(config, layers, material_mm3, checksum)
    settings_slot = writer.reserve(align(settings.pos(), 32))

    machine_name_bytes = config.machine_name.encode("utf-8") + b"\0"
    machine_name_pos = writer.pos()
    writer.write_bytes(machine_name_bytes)
    settings.patch_with(settings.machine_name_section, lambda patch: _write_section(patch, machine_name_pos, len(machine_name_bytes)))

    disclaimer_bytes = DISCLAIMER.encode("utf-8")
    disclaimer_pos = writer.pos()
    writer.write_bytes(disclaimer_bytes)
    settings.patch_with(settings.disclaimer_section, lambda patch: _write_section(patch, disclaimer_pos, len(disclaimer_bytes)))

    settings.write_at(settings.resin_offset, _u32(writer.pos()))
    _write_resin(writer, config)

    settings.write_at(settings.large_preview_offset, _u32(writer.pos()))
    _write_preview(writer, 400, 300)

    settings.write_at(settings.small_preview_offset, _u32(writer.pos()))
    _write_preview(writer, 300, 225)

    settings.write_at(settings.layer_table_offset, _u32(writer.pos()))
    layer_refs_pos = writer.reserve(16 * len(layers))

    encrypted_settings = _encrypt(bytes(settings.data))
    writer.write_at(settings_slot, encrypted_settings)
    writer.write_at(settings_section, _section_rev(settings_offset, len(encrypted_settings)))

    signature_bytes = _encrypt(hashlib.sha256(checksum.to_bytes(8, "little")).digest())
    writer.write_u32_le(0x422052FA)
    writer.write_u32_le(0)
    signature_pos = writer.pos()
    writer.write_bytes(signature_bytes)
    writer.write_at(signature_section, _section_rev(signature_pos, len(signature_bytes)))
    writer.write_u32_le(0x6D4232B3)

    for index, layer in enumerate(layers):
        cursor = writer.pos()
        page_number = cursor // PAGE_SIZE
        writer.write_at(layer_refs_pos + index * 16, _layer_ref(cursor % PAGE_SIZE, page_number))
        _write_layer(writer, layer, index, page_number)


class SettingsWriter(ByteWriter):
    def __init__(self) -> None:
        super().__init__()
        self.layer_table_offset = 0
        self.large_preview_offset = 0
        self.small_preview_offset = 0
        self.machine_name_section = 0
        self.disclaimer_section = 0
        self.resin_offset = 0


def _build_settings(config: PrintConfig, layers: list[CtbLayer], material_mm3: float, checksum: int) -> SettingsWriter:
    settings = SettingsWriter()
    settings.write_u64_le(checksum)
    settings.layer_table_offset = settings.reserve(4)
    settings.write_f32_le(config.size_x_mm)
    settings.write_f32_le(config.size_y_mm)
    settings.write_f32_le(config.size_z_mm)
    settings.write_u32_le(0)
    settings.write_u32_le(0)
    settings.write_f32_le(config.layer_height_mm * len(layers))
    settings.write_f32_le(config.layer_height_mm)
    settings.write_f32_le(config.exposure_time_s)
    settings.write_f32_le(config.bottom_exposure_time_s)
    settings.write_f32_le(0.0)
    settings.write_u32_le(config.bottom_layers)
    settings.write_u32_le(config.resolution_x)
    settings.write_u32_le(config.resolution_y)
    settings.write_u32_le(len(layers))
    settings.large_preview_offset = settings.reserve(4)
    settings.small_preview_offset = settings.reserve(4)
    settings.write_u32_le(_estimate_print_time(config, len(layers)))
    settings.write_u32_le(1)
    settings.write_f32_le(config.lift_distance_mm)
    settings.write_f32_le(config.lift_speed_mm_min)
    settings.write_f32_le(config.lift_distance_mm)
    settings.write_f32_le(config.lift_speed_mm_min)
    settings.write_f32_le(config.retract_speed_mm_min)
    settings.write_f32_le(material_mm3 / 1000.0)
    settings.write_f32_le(material_mm3 / 1000.0 * config.resin_density_g_ml)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.write_u32_le(1)
    settings.write_u16_le(config.light_pwm)
    settings.write_u16_le(config.bottom_light_pwm)
    settings.write_u32_le(DEFAULT_XOR_KEY)
    settings.write_f32_le(4.0)
    settings.write_f32_le(320.0)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.machine_name_section = settings.reserve(8)
    settings.write_u8(7)
    settings.write_u16_le(0)
    settings.write_u8(0x40)
    settings.write_u32_le(0)
    settings.write_u32_le(0)
    settings.write_f32_le(config.wait_after_retract_s)
    settings.write_f32_le(0.0)
    settings.write_u32_le(config.transition_layers)
    settings.write_f32_le(config.retract_speed_mm_min)
    settings.write_f32_le(90.0)
    settings.write_u32_le(0)
    settings.write_f32_le(4.0)
    settings.write_u32_le(0)
    settings.write_f32_le(4.0)
    settings.write_f32_le(config.wait_after_retract_s)
    settings.write_f32_le(0.0)
    settings.write_f32_le(0.0)
    settings.write_f32_le(1.5)
    settings.reserve(4 * 2)
    settings.write_u32_le(4)
    settings.write_u32_le(max(0, len(layers) - 1))
    settings.reserve(4 * 4)
    settings.disclaimer_section = settings.reserve(8)
    settings.write_u32_le(0)
    settings.resin_offset = settings.reserve(4)
    settings.reserve(4 * 2)
    return settings


def _write_layer(writer: ByteWriter, layer: CtbLayer, layer_index: int, page_number: int) -> None:
    writer.write_u32_le(0x58)
    writer.write_f32_le(layer.position_z_mm)
    writer.write_f32_le(layer.exposure_s)
    writer.write_f32_le(0.0)
    layer_offset = writer.reserve(4)
    writer.write_u32_le(page_number)
    writer.write_u32_le(len(layer.data))
    writer.write_u32_le(0)
    _write_section(writer, 0, 0)
    writer.write_f32_le(layer.lift_height_mm)
    writer.write_f32_le(layer.lift_speed_mm_min)
    writer.write_f32_le(0.0)
    writer.write_f32_le(0.0)
    writer.write_f32_le(layer.retract_speed_mm_min)
    writer.write_f32_le(0.0)
    writer.write_f32_le(0.0)
    writer.write_f32_le(0.0)
    writer.write_f32_le(0.0)
    writer.write_f32_le(layer.rest_after_retract_s)
    writer.write_f32_le(layer.light_pwm)
    writer.write_u32_le(0)

    data_pos = writer.pos()
    writer.write_at(layer_offset, _u32(data_pos))
    encrypted = bytearray(layer.data)
    _xor_layer(encrypted, DEFAULT_XOR_KEY, layer_index)
    writer.write_bytes(encrypted)


def _write_preview(writer: ByteWriter, width: int, height: int) -> None:
    writer.write_u32_le(width)
    writer.write_u32_le(height)
    section = writer.reserve(8)
    data = _preview_rle(width, height, (0, 0, 0))
    offset = writer.pos()
    writer.write_bytes(data)
    writer.write_at(section, _section(offset, len(data)))


def _preview_rle(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    red, green, blue = rgb
    color = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)
    out = bytearray()
    remaining = width * height
    while remaining:
        length = min(0xFFF, remaining)
        if length <= 2:
            value = color & ~0x20
            for _ in range(length):
                out.extend(value.to_bytes(2, "little"))
        else:
            out.extend((color | 0x20).to_bytes(2, "little"))
            out.extend(((length - 1) | 0x3000).to_bytes(2, "little"))
        remaining -= length
    return bytes(out)


def _write_resin(writer: ByteWriter, config: PrintConfig) -> None:
    writer.write_u32_be(0)
    writer.write_u8(64)
    writer.write_u8(64)
    writer.write_u8(64)
    writer.write_u8(255)
    machine_address = writer.reserve(4)
    resin_type = writer.reserve(8)
    resin_name = writer.reserve(8)
    machine_size = writer.reserve(4)
    writer.write_f32_le(config.resin_density_g_ml)
    writer.write_u32_le(0)

    machine = config.machine_name.encode("utf-8")
    machine_pos = writer.pos()
    writer.write_bytes(machine)
    writer.write_at(machine_address, _u32(machine_pos))
    writer.write_at(machine_size, _u32(len(machine)))
    _write_string_section_rev(writer, resin_type, "Normal")
    _write_string_section_rev(writer, resin_name, config.resin_name)


def _write_string_section_rev(writer: ByteWriter, patch_offset: int, value: str) -> None:
    raw = value.encode("utf-8")
    offset = writer.pos()
    writer.write_bytes(raw)
    writer.write_at(patch_offset, _section_rev(offset, len(raw)))


def _write_section(writer: ByteWriter, offset: int, size: int) -> None:
    writer.write_u32_le(offset)
    writer.write_u32_le(size)


def _section(offset: int, size: int) -> bytes:
    return _u32(offset) + _u32(size)


def _section_rev(offset: int, size: int) -> bytes:
    return _u32(size) + _u32(offset)


def _layer_ref(offset: int, page: int) -> bytes:
    writer = ByteWriter()
    writer.write_u32_le(offset)
    writer.write_u32_le(page)
    writer.write_u32_le(0x58)
    writer.write_u32_le(0)
    return bytes(writer.data)


def _u32(value: int) -> bytes:
    return int(value & 0xFFFFFFFF).to_bytes(4, "little")


def _encrypt(data: bytes) -> bytes:
    return aes256_cbc_zero_encrypt(data, ENCRYPT_KEY, ENCRYPT_IV, pad_to=32)


def _xor_layer(data: bytearray, seed: int, layer: int) -> None:
    init = (seed * 0x2D83CDAC + 0xD8A83423) & 0xFFFFFFFF
    key = (((layer * 0x1E1530CD + 0xEC3D47CD) & 0xFFFFFFFF) * init) & 0xFFFFFFFF
    index = 0
    for i in range(len(data)):
        data[i] ^= (key >> (8 * index)) & 0xFF
        index += 1
        if index & 3 == 0:
            key = (key + init) & 0xFFFFFFFF
            index = 0


def _estimate_print_time(config: PrintConfig, layer_count: int) -> int:
    lift = config.lift_distance_mm / max(1.0, config.lift_speed_mm_min) * 60.0
    retract = config.retract_distance_mm / max(1.0, config.retract_speed_mm_min) * 60.0
    regular = config.exposure_time_s + lift + retract + config.wait_after_retract_s
    bottom = config.bottom_exposure_time_s + lift + retract + config.wait_after_retract_s
    return int(
        min(layer_count, config.bottom_layers) * bottom
        + max(0, layer_count - config.bottom_layers) * regular
    )
