from pydantic import BaseModel, Field


class Note(BaseModel):
    id: int
    title: str = Field(min_length=1, max_length=80)
    body: str = ""


class NoteIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    body: str = ""
