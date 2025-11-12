from __future__ import annotations

from typing import Literal, Optional, List

from pydantic import BaseModel, Field


class LayoutElement(BaseModel):
    id: str = Field(..., description="Client-side element identifier.")
    type: Literal["wall", "door", "window"]
    label: str
    width: float
    height: float
    left: float
    top: float
    angle: float = 0
    fill: str | None = None


class LayoutPayload(BaseModel):
    name: str
    ceiling_height: float = Field(..., gt=0)
    notes: Optional[str] = None
    elements: List[LayoutElement] = []


class LayoutResponse(LayoutPayload):
    layout_id: str


class RenderRequest(BaseModel):
    layout_id: Optional[str] = None
    prompt: str
    style_preset: str
    furniture_assets: List[str] = []
    nano_banana_key: Optional[str] = None


class RenderJob(BaseModel):
    job_id: str
    status: Literal["queued", "processing", "complete"]
    prompt: str
    style_preset: str
    image_url: Optional[str] = None


class MaterialEditRequest(BaseModel):
    render_id: Optional[str] = None
    element_id: str
    description: str
    color: str


class MaterialEditResponse(BaseModel):
    edit_id: str
    status: Literal["queued", "complete"]
    preview_url: Optional[str] = None


class ApiSettings(BaseModel):
    nano_banana_key: Optional[str] = None
    asset_storage_key: Optional[str] = None
