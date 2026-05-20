class SlicerError(Exception):
    """Base class for user-facing slicer errors."""


class MeshError(SlicerError):
    """Raised when mesh input is invalid or unsupported."""


class ConfigError(SlicerError):
    """Raised when slicing or printer settings are unsafe."""


class FormatError(SlicerError):
    """Raised when a binary output format cannot be produced safely."""
