"""Workspace providers and registry for hermes-editor (Stage 5A)."""

from .base import (
    BINARY_SNIFF_BYTES,
    MAX_TEXT_BYTES,
    TEMP_PREFIX,
    ConflictError,
    OfflineError,
    PathRejected,
    ProviderError,
    WorkspaceProvider,
    file_revision,
    is_binary,
    validate_rel_path,
)
from .local import LocalProvider

__all__ = [
    "BINARY_SNIFF_BYTES", "MAX_TEXT_BYTES", "TEMP_PREFIX",
    "ConflictError", "OfflineError", "PathRejected", "ProviderError",
    "WorkspaceProvider", "LocalProvider",
    "file_revision", "is_binary", "validate_rel_path",
]
