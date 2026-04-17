# SDLC Project

This repository contains:

- A FastAPI backend in `server/`
- A React + Vite frontend in `clerk-react/`
- MySQL persistence via `database/data.py`
- Optional local LLM and embeddings support for BRD/TOC generation

## 1. Prerequisites

- Python 3.10+
- Node.js 18+
- MySQL 8+
- (Optional) Ollama running locally for AI features

## 2. Environment Setup

Create a root `.env` file in the repository folder (same level as `server/` and `database/`).

Suggested values:

```env
# Backend host/port
HOST=127.0.0.1
PORT=8000

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=sdlc

# Ollama (optional but recommended for BRD/TOC generation)
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=deepseek-llm:7b
OLLAMA_TIMEOUT_SEC=300

# Embedding / OCR options
USE_GPU=auto
BGE_MODEL_NAME=BAAI/bge-base-en-v1.5
# BGE_MODEL_PATH=
```

Create a frontend env file at `clerk-react/.env`:

```env
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
# Optional: comma-separated fallback backend URLs
VITE_API_BASE_URLS=http://127.0.0.1:8000,http://localhost:8000
```

## 3. Install Dependencies

From repository root:

```bash
pip install -r requirements.txt
```

From `clerk-react/`:

```bash
npm install
```

If PowerShell blocks npm scripts on your machine, use:

```bash
npm.cmd install
```

## 4. Start the Project

Run backend and frontend in separate terminals.

### Terminal A: Backend (FastAPI)

From repository root:

```bash
python -m server.main
```

Backend URL: `http://127.0.0.1:8000`

Health check:

```bash
curl http://127.0.0.1:8000/health
```

### Terminal B: Frontend (Vite)

```bash
cd clerk-react
npm run dev
```

If using PowerShell and npm policy errors:

```bash
npm.cmd run dev
```

Frontend URL (default): `http://127.0.0.1:5173` or `http://localhost:5173`

## 5. What Must Be Running

- MySQL service must be running before backend startup.
- Ollama is needed for full AI drafting/refinement flows.
  - Without Ollama, some generation features may fail or use fallback output.

## 6. Quick Troubleshooting

- Backend cannot connect to DB:
  - Verify `MYSQL_*` values in `.env`
  - Ensure MySQL service is running and credentials are valid
- Frontend shows missing Clerk key:
  - Set `VITE_CLERK_PUBLISHABLE_KEY` in `clerk-react/.env`
- Frontend cannot reach API:
  - Confirm backend is up on port `8000`
  - Set `VITE_API_BASE_URLS` if using a different host/port

## 7. Development Notes

- Uploaded files are stored in `uploads/`
- Chroma DB persistence is under `chroma_db/`
- Existing backend CORS allows localhost dev origins
