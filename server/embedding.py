from __future__ import annotations

import os
from pathlib import Path

import chromadb
from sentence_transformers import SentenceTransformer


_EMBEDDER = None
_CHROMA_CLIENT = None


def _embedding_device() -> str:
	use_gpu_env = os.getenv("USE_GPU", "auto").strip().lower()
	if use_gpu_env in {"0", "false", "no", "off"}:
		return "cpu"
	if use_gpu_env in {"1", "true", "yes", "on"}:
		return "cuda"

	try:
		import torch

		return "cuda" if torch.cuda.is_available() else "cpu"
	except Exception:
		return "cpu"


def _get_embedder() -> SentenceTransformer:
	global _EMBEDDER
	if _EMBEDDER is None:
		local_path = os.getenv("BGE_MODEL_PATH", "").strip()
		model_name = os.getenv("BGE_MODEL_NAME", "BAAI/bge-base-en-v1.5").strip()
		device = _embedding_device()

		if local_path:
			resolved = Path(local_path).expanduser().resolve()
			if not resolved.exists():
				raise ValueError(f"BGE_MODEL_PATH does not exist: {resolved}")
			_EMBEDDER = SentenceTransformer(str(resolved), device=device)
		else:
			_EMBEDDER = SentenceTransformer(model_name, device=device)
	return _EMBEDDER


def _get_client() -> chromadb.PersistentClient:
	global _CHROMA_CLIENT
	if _CHROMA_CLIENT is None:
		chroma_path = Path(__file__).resolve().parents[1] / "chroma_db"
		chroma_path.mkdir(parents=True, exist_ok=True)
		_CHROMA_CLIENT = chromadb.PersistentClient(path=str(chroma_path))
	return _CHROMA_CLIENT


def _chunk_text(text: str, chunk_size: int = 900, overlap: int = 120) -> list[str]:
	content = text.strip()
	if not content:
		return []

	chunks: list[str] = []
	start = 0
	while start < len(content):
		end = min(len(content), start + chunk_size)
		chunks.append(content[start:end])
		if end >= len(content):
			break
		start = max(0, end - overlap)

	return chunks


def upsert_project_embeddings(project_id: int, parsed_docs: list[dict]) -> int:
	client = _get_client()
	collection = client.get_or_create_collection(name=f"project_{project_id}")
	embedder = _get_embedder()

	ids: list[str] = []
	metadatas: list[dict] = []
	documents: list[str] = []

	for doc_index, parsed in enumerate(parsed_docs):
		chunks = _chunk_text(parsed["content"])
		for chunk_index, chunk in enumerate(chunks):
			ids.append(f"{project_id}-{doc_index}-{chunk_index}")
			metadatas.append(
				{
					"project_id": project_id,
					"document_type": parsed["document_type"],
					"file_name": parsed["file_name"],
					"chunk_index": chunk_index,
				}
			)
			documents.append(chunk)

	if not documents:
		return 0

	embeddings = _get_embedder().encode(documents, normalize_embeddings=True).tolist()
	collection.upsert(ids=ids, documents=documents, metadatas=metadatas, embeddings=embeddings)
	return len(documents)


def retrieve_project_context(project_id: int, query: str, top_k: int = 10) -> str:
	client = _get_client()
	collection = client.get_or_create_collection(name=f"project_{project_id}")
	if collection.count() == 0:
		return ""

	query_vector = _get_embedder().encode([query], normalize_embeddings=True).tolist()[0]
	result = collection.query(query_embeddings=[query_vector], n_results=top_k)

	chunks = result.get("documents", [[]])
	if not chunks or not chunks[0]:
		return ""

	return "\n\n".join(chunks[0])
