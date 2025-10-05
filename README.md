# Meteor Madness

asteroid impact simulation and visualization tool. calculates impact effects, tsunami propagation, and damage zones with interactive 3D visualization.

## Quick Start

### Option 1: Docker (Recommended)
```bash
docker-compose up --build
```
- frontend: http://localhost:3000
- backend API: http://localhost:8000

### Option 2: Manual Setup

**Backend:**
```bash
cd Meteor_Madness_Backend
pip install -r requirements.txt
uvicorn main:app --reload
```

**Frontend:**
```bash
cd Meteor_Madness_Frontend
npm install
npm run dev
```

## What it does

- asteroid catalog browsing (2000+ entries)
- orbital mechanics simulation
- impact location targeting
- blast radius & tsunami calculations
- population casualty estimates
- mitigation strategy analysis
- 3D visualization with Three.js

backend handles physics calculations, frontend renders the results. uses NASA JPL data for asteroid properties.

## API Endpoints

- `GET /asteroids` - catalog data
- `POST /simulate/{mode}` - run simulations
- `GET /simulation/{job_id}` - check status
- `POST /impact` - impact calculations

## Large Data File

The population data file (251MB) is too large for GitHub. Download it here:

**Direct Download:** [GHS_POP_E2030_GLOBE_R2023A_54009_1000_V1_0.tif](https://drive.google.com/file/d/1n0jSAj4rl5dhPvRGAa4s-PMr3YHpPmh5/view?usp=sharing)

1. Download the file from Google Drive
2. Place it in `Meteor_Madness_Backend/utils/`
3. Or run without it - population estimates will use fallback calculations

## Tech Stack

**Backend:** FastAPI, NumPy, SciPy, AstroPy  
**Frontend:** React, TypeScript, Three.js, Leaflet

built for impact analysis and planetary defense research.
