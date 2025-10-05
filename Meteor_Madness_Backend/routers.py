from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
import random
import asyncio
from typing import Dict, Any, List

#custom lib imports
import api_calls as api
import sim

#startup

app = FastAPI(
    title="QuackSpaceMeteorMadness",
    version="0.1"
)

service_status = 1
request_count = 0
startup_time = datetime.now(timezone.utc)

async_results = {}


###START DB###
NEO = api.initiate_NEO()

### CORS ###
 
# (frontend likely on Vite default http://localhost:5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

#### PARSING ####


def _map_asteroid(raw: Dict[str, Any]) -> Dict[str, Any]:
    # Provide safe numeric parsing helpers
    def num(val):
        return val if isinstance(val, (int, float)) else None
    diameter = num(raw.get("diameter"))  # Already in km per NASA small-body db (check upstream)
    density = num(raw.get("density"))  # Might be None often
    # Derive mass if both diameter & density exist
    mass = None
    if diameter and density and diameter > 0 and density > 0:
        radius_m = (diameter * 1000) / 2.0
        volume_m3 = 4/3 * 3.141592653589793 * radius_m**3
        mass = volume_m3 * density  # kg
    rotation_period = num(raw.get("rot_per"))  # hours already? Assume hours
    mapped = {
        "id": str(raw.get("spkid")),
        "name": raw.get("name") or raw.get("full_name") or str(raw.get("spkid")),
        "diameter": diameter or 0,
        "density": density or 0,
        "velocity": None,  # Not provided by current dataset
        "mass": mass,
        "albedo": num(raw.get("albedo")),
        "rotation_period": rotation_period,
        "spectral_type": raw.get("spec_T") or raw.get("spec_B"),
    }
    return mapped



####GET REQUESTS####

@app.get("/")
def root():
    uptime = (datetime.now(timezone.utc) - startup_time).total_seconds()
    return {"status": service_status, "request_count": request_count, "uptime_seconds": uptime}


@app.get("/asteroids", response_model=None)
def asteroids_catalog(start: int = 0, limit: int = 200):
    if limit <= 0:
        raise HTTPException(status_code=400, detail="limit must be > 0")
    result = api.NEO_catalog(NEO, start, limit)
    items = [_map_asteroid(x) for x in result]
    return {
        "asteroids": items,
        "total": len(items),
        "limit": limit,
        "offset": start,
    }

@app.get("/asteroids/{obj_id}")
def asteroid_data(obj_id: str):
    # Convert string ID to integer to match database key format
    try:
        obj_id_int = int(obj_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid asteroid ID format")
    
    raw = api.NEO_by_id(NEO, obj_id_int)
    if raw is None:
        raise HTTPException(status_code=404, detail="Asteroid not found")
    return _map_asteroid(raw)


@app.post("/simulate/{obj_id}")
async def simulate(obj_id: str, preview: str = "true"):
    print(f"DEBUG simulate: obj_id={obj_id}, preview={preview}")
    is_preview = preview.lower() in ("true", "1", "yes")
    print(f"DEBUG simulate: converted is_preview={is_preview}")

    # Try direct string key first (since api_calls keeps keys as cleaned strings)
    raw = api.NEO_by_id(NEO, obj_id)
    attempted_int = None
    if raw is None:
        try:
            attempted_int = int(obj_id)
            raw = api.NEO_by_id(NEO, attempted_int)
        except ValueError:
            attempted_int = None
    print(f"DEBUG simulate: raw data found: {raw is not None} (attempted_int={attempted_int})")
    if raw is None:
        # Provide diagnostic info: sample a few keys
        sample_keys = list(NEO.keys())[:5]
        raise HTTPException(status_code=404, detail={
            "error": "Asteroid not found",
            "requested": obj_id,
            "attempted_int": attempted_int,
            "sample_keys": sample_keys
        })

    if is_preview:
        orbit_payload = sim.static_orbit(raw)
        if isinstance(orbit_payload, dict):
            return {
                "asteroid_trajectory": orbit_payload.get("points", []),
                "orbit_meta": orbit_payload.get("orbit_meta", {})
            }
        # backward fallback if function returned legacy list
        return {"asteroid_trajectory": orbit_payload}

    job_id = random.randint(10000, 99999)
    async_results[str(job_id)] = {"done": False, "data": None}

    async def _run_full():
        try:
            result = await sim.full_sim(raw)
            async_results[str(job_id)] = {"done": True, "data": result}
        except Exception as exc:  # pragma: no cover simple diagnostic capture
            async_results[str(job_id)] = {"done": True, "data": {"error": str(exc)}}

    asyncio.create_task(_run_full())
    return {"job_id": str(job_id), "status": "started"}


@app.get("/reports/{job_id}")
def get_report(job_id: str, response: Response):
    # job ids stored as int keys originally
    job = async_results.get(job_id)
    if job is None and job_id.isdigit():
        job = async_results.get(int(job_id))
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.get("done"):
        response.status_code = status.HTTP_202_ACCEPTED
        return {"status": "processing"}
    
    data = job.get("data")
    try:
        del async_results[job_id]
    except KeyError:
        try:
            del async_results[int(job_id)]
        except Exception:
            pass
    return data

####POST REQUESTS####

@app.post("/simulate_impact")
def impact_sim(data: dict):
    result = sim.impact(data)
    return result
    


### if run directly ###

if __name__ == "__main__":
    import uvicorn
    # Bind explicitly to localhost for dev convenience
    uvicorn.run("routers:app", host="127.0.0.1", port=8000, reload=True)
