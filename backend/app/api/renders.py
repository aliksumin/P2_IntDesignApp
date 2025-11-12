from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException

from app.schemas import RenderJob, RenderRequest
from app.state import store

router = APIRouter(prefix="/api/renders", tags=["renders"])


@router.post("", response_model=RenderJob)
def request_render(payload: RenderRequest) -> RenderJob:
    job_id = str(uuid4())
    job = {
        "job_id": job_id,
        "prompt": payload.prompt,
        "style_preset": payload.style_preset,
        "status": "queued",
        "image_url": None,
    }
    store.render_jobs[job_id] = job
    return RenderJob(**job)


@router.get("", response_model=list[RenderJob])
def list_renders() -> list[RenderJob]:
    return [RenderJob(**job) for job in store.render_jobs.values()]


@router.post("/{job_id}/complete", response_model=RenderJob)
def mark_render_complete(job_id: str) -> RenderJob:
    job = store.render_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Render job not found")
    job["status"] = "complete"
    job["image_url"] = job.get(
        "image_url",
        "https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1200&q=80",
    )
    return RenderJob(**job)
