from fastapi import APIRouter, FastAPI

from . import layouts, materials, renders, settings


def register_routers(app: FastAPI) -> None:
    api_router = APIRouter()
    api_router.include_router(layouts.router)
    api_router.include_router(renders.router)
    api_router.include_router(materials.router)
    api_router.include_router(settings.router)
    app.include_router(api_router)
