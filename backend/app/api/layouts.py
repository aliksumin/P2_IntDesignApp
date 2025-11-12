from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app.schemas import LayoutPayload, LayoutResponse
from app.state import store

router = APIRouter(prefix="/api/layouts", tags=["layouts"])


@router.post("", response_model=LayoutResponse)
def create_layout(payload: LayoutPayload) -> LayoutResponse:
    layout_id = str(uuid4())
    store.layouts[layout_id] = payload.model_dump()
    return LayoutResponse(layout_id=layout_id, **payload.model_dump())


@router.get("", response_model=list[LayoutResponse])
def list_layouts() -> list[LayoutResponse]:
    return [
        LayoutResponse(layout_id=layout_id, **data) for layout_id, data in store.layouts.items()
    ]


@router.get("/{layout_id}", response_model=LayoutResponse)
def get_layout(layout_id: str) -> LayoutResponse:
    if layout_id not in store.layouts:
        raise HTTPException(status_code=404, detail="Layout not found")
    return LayoutResponse(layout_id=layout_id, **store.layouts[layout_id])
