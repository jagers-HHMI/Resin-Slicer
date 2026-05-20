from __future__ import annotations

import struct
from collections.abc import Callable


class ByteWriter:
    """Small binary serializer with patch/reserve support."""

    def __init__(self) -> None:
        self.data = bytearray()

    def pos(self) -> int:
        return len(self.data)

    def reserve(self, size: int) -> int:
        if size < 0:
            raise ValueError("reserve size cannot be negative")
        offset = len(self.data)
        self.data.extend(b"\0" * size)
        return offset

    def write_at(self, offset: int, payload: bytes) -> None:
        end = offset + len(payload)
        if offset < 0 or end > len(self.data):
            raise IndexError("patch is outside writer bounds")
        self.data[offset:end] = payload

    def patch_with(self, offset: int, callback: Callable[["ByteWriter"], None]) -> None:
        patch = ByteWriter()
        callback(patch)
        self.write_at(offset, bytes(patch.data))

    def view_mut(self, offset: int, size: int) -> memoryview:
        return memoryview(self.data)[offset : offset + size]

    def write_bytes(self, payload: bytes | bytearray | memoryview) -> None:
        self.data.extend(payload)

    def write_u8(self, value: int) -> None:
        self.data.append(value & 0xFF)

    def write_bool(self, value: bool) -> None:
        self.write_u8(1 if value else 0)

    def write_u16_be(self, value: int) -> None:
        self.data.extend(struct.pack(">H", value & 0xFFFF))

    def write_u16_le(self, value: int) -> None:
        self.data.extend(struct.pack("<H", value & 0xFFFF))

    def write_u32_be(self, value: int) -> None:
        self.data.extend(struct.pack(">I", value & 0xFFFFFFFF))

    def write_u32_le(self, value: int) -> None:
        self.data.extend(struct.pack("<I", value & 0xFFFFFFFF))

    def write_u64_le(self, value: int) -> None:
        self.data.extend(struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF))

    def write_f32_be(self, value: float) -> None:
        self.data.extend(struct.pack(">f", float(value)))

    def write_f32_le(self, value: float) -> None:
        self.data.extend(struct.pack("<f", float(value)))


def sized_ascii(text: str, size: int) -> bytes:
    raw = text.encode("ascii", errors="replace")[:size]
    return raw + b"\0" * (size - len(raw))


def align(value: int, boundary: int) -> int:
    return ((value + boundary - 1) // boundary) * boundary
