# P2_IntDesignApp

InteriorDesignApp is a three-stage workflow for transforming a 2D room layout into photorealistic renders powered by Nano Banana and iterative material refinements. Users sketch or upload precise floor plans, convert them into perspective renders enriched with furniture references and prompts, and then selectively restyle materials for any object in the scene.

## Features
- Interactive layout builder with drawing tools plus SVG/image upload and validation.
- Asset ingestion for furniture references, prompt editing, and scene metadata management.
- Render orchestration that submits scene graphs to Nano Banana for perspective views.
- Material editing pipeline that targets masked objects for Nano Banana retexturing.
- History, versioning, and gallery storage backed by PostgreSQL, Redis, and object storage.

## Getting Started
1. Clone the repository and install dependencies for both frontend (`frontend/`) and backend (`backend/`).
2. Frontend: `cd frontend && npm install` (already done) then `npm run dev` to launch the Next.js UI.
3. Backend: `cd backend && .venv\Scripts\activate` followed by `uvicorn app.main:app --reload` once FastAPI entrypoints exist.
4. Configure `.env` files for database URLs, Redis, object storage, and Nano Banana credentials before running services.

## Controls
- **Layout Stage**: use drawing tools for walls/doors/windows, or upload SVG/DXF plans; snap/measure controls ensure accuracy.
- **Render Stage**: select layout, attach furniture samples, tweak text prompts, and submit render jobs; monitor progress indicators.
- **Material Stage**: click rendered objects to reveal masks, choose new material keywords/swatches, and launch targeted edits with undo history.
