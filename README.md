# P2_IntDesignApp

InteriorDesignApp is a three-stage workflow for transforming a 2D room layout into photorealistic renders powered by Nano Banana and iterative material refinements. Users sketch or upload precise floor plans, convert them into perspective renders enriched with furniture references and prompts, and then selectively restyle materials for any object in the scene.

## Features
- Flat-design, light-themed layout studio powered by Fabric.js for walls/doors/windows plus image overlays and metadata capture.
- Render stage with React Query mutations, furniture reference uploads, prompt presets, and Nano Banana job tracking.
- Material editing workstation where objects inherit from the layout graph, accept per-object prompts, and log edit history with previews.
- Local settings drawer for Nano Banana and asset storage API keys, persisted via Zustand.
- FastAPI backend scaffold exposing `/api/layouts`, `/api/renders`, `/api/materials`, and `/api/settings` endpoints backed by an in-memory store (ready for PostgreSQL/Redis swaps).

## Getting Started
1. Clone the repository and install dependencies for both frontend (`frontend/`) and backend (`backend/`).
2. Frontend workflow:
   - `cd frontend`
   - `npm install` (already satisfied in this snapshot)
   - `npm run dev` then navigate to `http://localhost:3000` to access the studio with all three stages.
3. Backend workflow:
   - `cd backend`
   - `python -m venv .venv` and activate it (`.\.venv\Scripts\activate`)
   - `pip install -r requirements.txt`
   - `uvicorn app.main:app --reload` to serve the mock API for layouts, renders, materials, and settings.
4. Configure `.env` files (frontend and backend) with Nano Banana credentials, storage keys, database URLs, Redis, etc., before integrating with real services.

## Controls
- **Layout Stage**: use drawing tools for walls/doors/windows, or upload SVG/DXF plans; snap/measure controls ensure accuracy.
- **Render Stage**: select layout, attach furniture samples, tweak text prompts, and submit render jobs; monitor progress indicators.
- **Material Stage**: click rendered objects to reveal masks, choose new material keywords/swatches, and launch targeted edits with undo history.
