"""What a visitor may keep: projects, uploaded files and customizations.

On your own computer or server everyone gets the server's own limits (`local_plan`, from `WebConfig`). An add-on
(server/addon.py) may give each visitor a plan of its own instead.
"""

from __future__ import annotations

from dataclasses import dataclass

MB = 1024 * 1024
GB = 1024 * MB


@dataclass(frozen=True)
class Plan:
    key: str
    label: str
    projects: int
    asset_quota: int  # bytes of uploaded pictures
    max_assets: int
    kits: int = 0  # own customizations (server/kits.py) kept; 0: can't make or use any (gallery ones don't count)
    limit_note: str = ". Delete one first."  # ends the message when something doesn't fit: how to make room

    def public(self) -> dict:
        return {"key": self.key, "label": self.label, "projects": self.projects, "storageMb": self.asset_quota // MB,
                "storage": self.asset_quota,
                "maxAssets": self.max_assets, "kits": self.kits}


def local_plan(cfg) -> Plan:
    """No add-on: the server's own limits."""
    return Plan("local", "Local", projects=cfg.max_projects, asset_quota=cfg.asset_quota, max_assets=cfg.max_assets,
                kits=cfg.max_kits)
