import os
import subprocess
from fastapi import FastAPI, HTTPException
from .models import Note, NoteIn

app = FastAPI()
NOTES: dict[int, Note] = {}


@app.get("/notes")
def list_notes():
    return list(NOTES.values())


@app.post("/notes")
def create_note(data: NoteIn):
    if len(NOTES) >= 1000:
        raise HTTPException(status_code=429, detail="too many notes")
    note = Note(id=len(NOTES) + 1, **data.model_dump())
    NOTES[note.id] = note
    return note


@app.get("/export")
def export(name: str):
    subprocess.run("zip /tmp/" + name + ".zip notes.json", shell=True)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app)
