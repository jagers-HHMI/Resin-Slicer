from __future__ import annotations

SBOX = [
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]

RCON = [0x00000000, 0x01000000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000, 0x80000000, 0x1B000000, 0x36000000]


def _xtime(value: int) -> int:
    value <<= 1
    if value & 0x100:
        value ^= 0x11B
    return value & 0xFF


def _mul2(value: int) -> int:
    return _xtime(value)


def _mul3(value: int) -> int:
    return _xtime(value) ^ value


def _sub_word(word: int) -> int:
    return (
        SBOX[(word >> 24) & 0xFF] << 24
        | SBOX[(word >> 16) & 0xFF] << 16
        | SBOX[(word >> 8) & 0xFF] << 8
        | SBOX[word & 0xFF]
    )


def _rot_word(word: int) -> int:
    return ((word << 8) & 0xFFFFFFFF) | (word >> 24)


class AES256:
    """Minimal AES-256 encryptor used for CTB compatibility."""

    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("AES-256 key must be 32 bytes")
        self.round_keys = self._expand_key(key)

    @staticmethod
    def _expand_key(key: bytes) -> list[bytes]:
        words = [int.from_bytes(key[i : i + 4], "big") for i in range(0, 32, 4)]
        i = 8
        while len(words) < 60:
            temp = words[-1]
            if i % 8 == 0:
                temp = _sub_word(_rot_word(temp)) ^ RCON[i // 8]
            elif i % 8 == 4:
                temp = _sub_word(temp)
            words.append(words[i - 8] ^ temp)
            i += 1
        return [b"".join(word.to_bytes(4, "big") for word in words[i : i + 4]) for i in range(0, 60, 4)]

    @staticmethod
    def _add_round_key(state: bytearray, round_key: bytes) -> None:
        for i, key_byte in enumerate(round_key):
            state[i] ^= key_byte

    @staticmethod
    def _sub_bytes(state: bytearray) -> None:
        for i, value in enumerate(state):
            state[i] = SBOX[value]

    @staticmethod
    def _shift_rows(state: bytearray) -> None:
        state[1], state[5], state[9], state[13] = state[5], state[9], state[13], state[1]
        state[2], state[6], state[10], state[14] = state[10], state[14], state[2], state[6]
        state[3], state[7], state[11], state[15] = state[15], state[3], state[7], state[11]

    @staticmethod
    def _mix_columns(state: bytearray) -> None:
        for col in range(4):
            i = col * 4
            a0, a1, a2, a3 = state[i], state[i + 1], state[i + 2], state[i + 3]
            state[i] = _mul2(a0) ^ _mul3(a1) ^ a2 ^ a3
            state[i + 1] = a0 ^ _mul2(a1) ^ _mul3(a2) ^ a3
            state[i + 2] = a0 ^ a1 ^ _mul2(a2) ^ _mul3(a3)
            state[i + 3] = _mul3(a0) ^ a1 ^ a2 ^ _mul2(a3)

    def encrypt_block(self, block: bytes) -> bytes:
        if len(block) != 16:
            raise ValueError("AES block must be 16 bytes")
        state = bytearray(block)
        self._add_round_key(state, self.round_keys[0])
        for round_index in range(1, 14):
            self._sub_bytes(state)
            self._shift_rows(state)
            self._mix_columns(state)
            self._add_round_key(state, self.round_keys[round_index])
        self._sub_bytes(state)
        self._shift_rows(state)
        self._add_round_key(state, self.round_keys[14])
        return bytes(state)


def aes256_cbc_zero_encrypt(data: bytes, key: bytes, iv: bytes, pad_to: int = 16) -> bytes:
    if len(iv) != 16:
        raise ValueError("AES-CBC IV must be 16 bytes")
    if pad_to % 16 != 0:
        raise ValueError("pad_to must be a multiple of the AES block size")

    padded_len = ((len(data) + pad_to - 1) // pad_to) * pad_to
    if padded_len == 0:
        padded_len = pad_to
    buf = bytearray(data)
    buf.extend(b"\0" * (padded_len - len(buf)))

    cipher = AES256(key)
    previous = iv
    out = bytearray()
    for offset in range(0, len(buf), 16):
        block = bytes(a ^ b for a, b in zip(buf[offset : offset + 16], previous))
        encrypted = cipher.encrypt_block(block)
        out.extend(encrypted)
        previous = encrypted
    return bytes(out)
