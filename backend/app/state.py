from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


@dataclass
class MemoryStore:
    layouts: Dict[str, dict] = field(default_factory=dict)
    render_jobs: Dict[str, dict] = field(default_factory=dict)
    material_edits: Dict[str, dict] = field(default_factory=dict)
    settings: Dict[str, str] = field(default_factory=dict)


store = MemoryStore()
