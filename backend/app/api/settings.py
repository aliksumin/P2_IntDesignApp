from __future__ import annotations

from fastapi import APIRouter

from app.schemas import ApiSettings
from app.state import store

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("", response_model=ApiSettings)
def read_settings() -> ApiSettings:
    return ApiSettings(
        nano_banana_key=store.settings.get("nano_banana_key"),
        asset_storage_key=store.settings.get("asset_storage_key"),
    )


@router.post("", response_model=ApiSettings)
def save_settings(payload: ApiSettings) -> ApiSettings:
    if payload.nano_banana_key is not None:
        store.settings["nano_banana_key"] = payload.nano_banana_key
    if payload.asset_storage_key is not None:
        store.settings["asset_storage_key"] = payload.asset_storage_key
    return read_settings()
