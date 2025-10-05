"""Application entrypoint for Meteor Madness backend.

Run with:
	uvicorn main:app --reload --port 8000
or simply:
	python main.py
"""

from routers import app  # re-export FastAPI instance

if __name__ == "__main__":
	import uvicorn
	uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

