import unittest

from resin_slicer.formats.aes import AES256, aes256_cbc_zero_encrypt


class AESTests(unittest.TestCase):
    def test_aes_256_block_vector(self) -> None:
        key = bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4")
        block = bytes.fromhex("6bc1bee22e409f96e93d7e117393172a")
        expected = "f3eed1bdb5d2a03c064b5a7e3db181f8"
        self.assertEqual(AES256(key).encrypt_block(block).hex(), expected)

    def test_cbc_zero_padding_to_32_bytes(self) -> None:
        key = bytes(range(32))
        iv = bytes(range(16))
        encrypted = aes256_cbc_zero_encrypt(b"abc", key, iv, pad_to=32)
        self.assertEqual(len(encrypted), 32)
        self.assertNotEqual(encrypted[:3], b"abc")


if __name__ == "__main__":
    unittest.main()
