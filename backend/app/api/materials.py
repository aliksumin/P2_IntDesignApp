from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app.schemas import MaterialEditRequest, MaterialEditResponse
from app.state import store

router = APIRouter(prefix="/api/materials", tags=["materials"])


@router.post("", response_model=MaterialEditResponse)
def request_material_edit(payload: MaterialEditRequest) -> MaterialEditResponse:
    edit_id = str(uuid4())
    edit = {
        "edit_id": edit_id,
        "status": "queued",
        "preview_url": None,
        "element_id": payload.element_id,
    }
    store.material_edits[edit_id] = edit
    return MaterialEditResponse(**edit)


@router.post("/{edit_id}/complete", response_model=MaterialEditResponse)
def mark_material_complete(edit_id: str) -> MaterialEditResponse:
    edit = store.material_edits.get(edit_id)
    if not edit:
        raise HTTPException(status_code=404, detail="Material edit not found")
    edit["status"] = "complete"
    edit["preview_url"] = edit.get(
        "preview_url",
        "https://images.unsplash.com/photo-1449247709967-d4461a6a6103?auto=format&fit=crop&w=1200&q=80",
    )
    return MaterialEditResponse(**edit)
