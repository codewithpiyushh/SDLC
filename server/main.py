import sys
import os
from pathlib import Path
from typing import Any, Literal


# Allow running uvicorn from either repo root or the server directory.
ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
	sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Ensure current workspace .env values are used instead of stale shell values.
load_dotenv(ROOT_DIR / ".env", override=True)

from database.data import (
	create_project,
	delete_project,
	get_project,
	get_project_documents,
	init_db,
	list_project_versions,
	list_projects,
	ping_database,
	save_project_document_file,
	save_project_version,
)
from server.embedding import retrieve_project_context, upsert_project_embeddings
from server.parse import parse_project_documents
from server.toccreate import refine_toc_section, suggest_toc_sections
from server.workflow import LLMQuotaError, build_fallback_brd, run_brd_workflow


class ProjectCreateRequest(BaseModel):
	name: str
	createdBy: str
	description: str
	field: str
	pdfName: str


class ProjectVersionCreateRequest(BaseModel):
	source: Literal["workspace", "toc"]
	createdBy: str
	snapshot: dict[str, Any]


class TocRefineRequest(BaseModel):
	sectionTitle: str
	currentDescription: str
	instruction: str


app = FastAPI(title="SDLC Backend")

UPLOADS_DIR = Path(__file__).resolve().parents[1] / "uploads"

app.add_middleware(
	CORSMiddleware,
	allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
	# Allow local dev frontends on any port (Vite may switch ports).
	allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
	allow_credentials=True,
	allow_methods=["*"],
	allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
	UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
	init_db()


@app.get("/health")
def health() -> dict:
	return {"ok": True, "mysql": ping_database()}


@app.get("/projects")
def get_projects() -> list[dict]:
	return list_projects()


@app.post("/projects")
def post_project(payload: ProjectCreateRequest) -> dict:
	if payload.field not in {"IT", "Finance"}:
		raise HTTPException(status_code=400, detail="field must be IT or Finance")

	return create_project(
		name=payload.name.strip(),
		created_by=payload.createdBy.strip(),
		description=payload.description.strip(),
		field=payload.field,
		pdf_name=payload.pdfName.strip(),
	)


@app.post("/projects/upload")
async def post_project_with_upload(
	name: str = Form(...),
	createdBy: str = Form(...),
	description: str = Form(...),
	field: str = Form(...),
	pdfFile: UploadFile = File(...),
) -> dict:
	if field not in {"IT", "Finance"}:
		raise HTTPException(status_code=400, detail="field must be IT or Finance")

	filename = (pdfFile.filename or "").strip()
	if not filename:
		raise HTTPException(status_code=400, detail="Missing uploaded file name")

	if not filename.lower().endswith(".pdf"):
		raise HTTPException(status_code=400, detail="Only PDF files are allowed")

	safe_name = Path(filename).name
	target_path = UPLOADS_DIR / safe_name
	content = await pdfFile.read()
	target_path.write_bytes(content)
	await pdfFile.close()

	return create_project(
		name=name.strip(),
		created_by=createdBy.strip(),
		description=description.strip(),
		field=field,
		pdf_name=safe_name,
	)


@app.delete("/projects/{project_id}")
def remove_project(project_id: int) -> dict:
	deleted = delete_project(project_id)
	if not deleted:
		raise HTTPException(status_code=404, detail="Project not found")
	return {"deleted": True}


@app.post("/projects/{project_id}/versions")
def post_project_version(project_id: int, payload: ProjectVersionCreateRequest) -> dict:
	try:
		return save_project_version(
			project_id=project_id,
			source=payload.source,
			created_by=payload.createdBy.strip(),
			snapshot=payload.snapshot,
		)
	except Exception as exc:
		message = str(exc)
		if "Project not found" in message:
			raise HTTPException(status_code=404, detail="Project not found") from exc
		raise HTTPException(status_code=400, detail=message) from exc


@app.get("/projects/{project_id}/versions")
def get_project_versions(project_id: int) -> list[dict]:
	return list_project_versions(project_id)


@app.post("/projects/{project_id}/documents/upload")
async def upload_project_document(
	project_id: int,
	documentType: str = Form(...),
	file: UploadFile = File(...),
) -> dict:
	allowed_types = {"mom", "pre_documents", "transcripts", "final_brd"}
	if documentType not in allowed_types:
		raise HTTPException(status_code=400, detail="Unsupported document type")

	filename = (file.filename or "").strip()
	if not filename:
		raise HTTPException(status_code=400, detail="Missing uploaded file name")

	safe_name = Path(filename).name
	stored_name = f"project_{project_id}_{documentType}_{safe_name}"
	target_path = UPLOADS_DIR / stored_name
	content = await file.read()
	target_path.write_bytes(content)
	await file.close()

	try:
		documents = save_project_document_file(project_id, documentType, stored_name)
	except Exception as exc:
		message = str(exc)
		if "Project not found" in message:
			raise HTTPException(status_code=404, detail="Project not found") from exc
		raise HTTPException(status_code=400, detail=message) from exc

	return {"saved": True, "documents": documents}


@app.get("/projects/{project_id}/documents")
def fetch_project_documents(project_id: int) -> dict:
	documents = get_project_documents(project_id)
	if not documents:
		return {
			"projectId": project_id,
			"momFile": None,
			"preDocumentsFile": None,
			"transcriptsFile": None,
			"finalBrdFile": None,
		}
	return documents


def _build_project_context(project: dict, project_id: int, documents: dict) -> tuple[list[dict], str]:
	parsed_docs = parse_project_documents(
		project_pdf_name=project.get("pdfName") or "",
		documents=documents,
		uploads_dir=UPLOADS_DIR,
	)

	parts: list[str] = []
	if project.get("description"):
		parts.append(str(project["description"]))

	parts.extend(doc["content"] for doc in parsed_docs if doc.get("content"))
	context = "\n\n".join(parts).strip()
	return parsed_docs, context


@app.post("/projects/{project_id}/toc/suggest")
def suggest_project_toc(project_id: int) -> dict:
	project = get_project(project_id)
	if not project:
		raise HTTPException(status_code=404, detail="Project not found")

	documents = get_project_documents(project_id) or {
		"projectId": project_id,
		"momFile": None,
		"preDocumentsFile": None,
		"transcriptsFile": None,
		"finalBrdFile": None,
	}

	parsed_docs, context = _build_project_context(project, project_id, documents)
	if not context:
		raise HTTPException(status_code=400, detail="No source content found. Upload project docs first.")

	sections = suggest_toc_sections(project_name=project["name"], context=context)
	return {
		"projectId": project_id,
		"sections": sections,
		"sourceDocumentsParsed": len(parsed_docs),
	}


@app.post("/projects/{project_id}/toc/refine")
def refine_project_toc_section(project_id: int, payload: TocRefineRequest) -> dict:
	project = get_project(project_id)
	if not project:
		raise HTTPException(status_code=404, detail="Project not found")

	documents = get_project_documents(project_id) or {
		"projectId": project_id,
		"momFile": None,
		"preDocumentsFile": None,
		"transcriptsFile": None,
		"finalBrdFile": None,
	}

	_, context = _build_project_context(project, project_id, documents)
	if not context:
		context = project.get("description") or ""

	if not payload.instruction.strip():
		raise HTTPException(status_code=400, detail="Instruction is required")

	rewritten = refine_toc_section(
		project_name=project["name"],
		section_title=payload.sectionTitle.strip(),
		current_description=payload.currentDescription,
		instruction=payload.instruction,
		context=context,
	)

	return {
		"projectId": project_id,
		"sectionTitle": payload.sectionTitle,
		"description": rewritten,
	}


@app.post("/projects/{project_id}/brd/generate")
def generate_project_brd(project_id: int) -> dict:
	project = get_project(project_id)
	if not project:
		raise HTTPException(status_code=404, detail="Project not found")

	documents = get_project_documents(project_id) or {
		"projectId": project_id,
		"momFile": None,
		"preDocumentsFile": None,
		"transcriptsFile": None,
		"finalBrdFile": None,
	}

	parsed_docs, context = _build_project_context(project, project_id, documents)

	if not parsed_docs:
		raise HTTPException(status_code=400, detail="No parsable documents found for this project")

	chunk_count = upsert_project_embeddings(project_id=project_id, parsed_docs=parsed_docs)

	query = (
		f"Create a comprehensive BRD for project {project['name']} using all provided documents, "
		"requirements, and business context."
	)
	context = retrieve_project_context(project_id=project_id, query=query, top_k=20)
	if not context:
		context = "\n\n".join(doc["content"] for doc in parsed_docs)

	try:
		brd_markdown = run_brd_workflow(project_name=project["name"], context=context)
	except LLMQuotaError as exc:
		brd_markdown = build_fallback_brd(project_name=project["name"], context=context, reason=str(exc))
	except Exception as exc:
		raise HTTPException(status_code=500, detail=f"BRD generation failed: {exc}") from exc

	if not brd_markdown.strip():
		raise HTTPException(status_code=500, detail="LLM returned empty BRD")

	stored_name = f"project_{project_id}_final_brd.md"
	output_path = UPLOADS_DIR / stored_name
	output_path.write_text(brd_markdown, encoding="utf-8")

	try:
		documents_row = save_project_document_file(project_id, "final_brd", stored_name)
	except Exception as exc:
		raise HTTPException(status_code=500, detail=f"Failed to save final BRD metadata: {exc}") from exc

	return {
		"generated": True,
		"projectId": project_id,
		"chunksStored": chunk_count,
		"finalBrdFile": stored_name,
		"documents": documents_row,
		"brd": brd_markdown,
	}


if __name__ == "__main__":
	import uvicorn

	uvicorn.run(
		"server.main:app",
		host=os.getenv("HOST", "127.0.0.1"),
		port=int(os.getenv("PORT", "8000")),
		reload=True,
	)
