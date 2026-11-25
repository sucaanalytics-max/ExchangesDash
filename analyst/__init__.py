"""Read-only loader for the datasets this repository publishes. See analyst/README.md."""

from .loader import REGISTRY, Dataset, Snapshot, datasets, load, snapshot  # noqa: F401

__all__ = ["REGISTRY", "Dataset", "Snapshot", "datasets", "load", "snapshot"]
