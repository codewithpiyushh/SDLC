from __future__ import annotations

import json
import os
import re
import socket
from urllib import error, request
from typing import TypedDict


class BRDState(TypedDict):
	project_name: str
	context: str
	analysis: str
	brd_markdown: str


class LLMQuotaError(RuntimeError):
	"""Raised when the local LLM endpoint is unavailable or rate limited."""


def _ollama_base_url() -> str:
	return os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").strip().rstrip("/")


def _ollama_model() -> str:
	return os.getenv("OLLAMA_MODEL", "deepseek-llm:7b").strip()


def _ollama_timeout_seconds() -> int:
	try:
		value = int(os.getenv("OLLAMA_TIMEOUT_SEC", "300").strip())
		return max(60, value)
	except ValueError:
		return 300


def _ollama_generate(prompt: str, temperature: float = 0.2) -> str:
	url = f"{_ollama_base_url()}/api/generate"
	payload = {
		"model": _ollama_model(),
		"prompt": prompt,
		"stream": False,
		"options": {
			"temperature": temperature,
		},
	}
	data = json.dumps(payload).encode("utf-8")
	req = request.Request(
		url=url,
		data=data,
		headers={"Content-Type": "application/json"},
		method="POST",
	)

	try:
		with request.urlopen(req, timeout=_ollama_timeout_seconds()) as response:
			body = response.read().decode("utf-8")
	except error.HTTPError as exc:
		detail = exc.read().decode("utf-8", errors="ignore")
		message = f"Local LLM HTTP error {exc.code}: {detail or exc.reason}"
		if _is_quota_error(message):
			raise LLMQuotaError(message) from exc
		raise RuntimeError(message) from exc
	except (TimeoutError, socket.timeout) as exc:
		raise LLMQuotaError(
			"Local LLM request timed out. Increase OLLAMA_TIMEOUT_SEC or use a smaller/faster model."
		) from exc
	except error.URLError as exc:
		reason = str(getattr(exc, "reason", "")).lower()
		if "timed out" in reason:
			raise LLMQuotaError(
				"Local LLM request timed out. Increase OLLAMA_TIMEOUT_SEC or use a smaller/faster model."
			) from exc
		raise LLMQuotaError(
			"Could not reach local LLM endpoint. Ensure Ollama is running and the model is pulled."
		) from exc

	try:
		parsed = json.loads(body)
	except json.JSONDecodeError as exc:
		raise RuntimeError("Local LLM returned invalid JSON") from exc

	content = str(parsed.get("response", "")).strip()
	if not content:
		raise RuntimeError("Local LLM returned empty response")
	return content


def _is_quota_error(message: str) -> bool:
	text = message.lower()
	return (
		"quota exceeded" in text
		or "rate limit" in text
		or "429" in text
		or "resource_exhausted" in text
	)


def _extract_retry_seconds(message: str) -> int | None:
	match = re.search(r"retry in\s+([0-9]+(?:\.[0-9]+)?)s", message, re.IGNORECASE)
	if not match:
		return None
	try:
		return int(float(match.group(1)))
	except ValueError:
		return None


def build_fallback_brd(project_name: str, context: str, reason: str = "") -> str:
	trimmed_context = (context or "").strip()
	if len(trimmed_context) > 5000:
		trimmed_context = trimmed_context[:5000] + "\n\n[...truncated for brevity...]"

	notes = ""
	if reason:
		retry_seconds = _extract_retry_seconds(reason)
		notes = "Local LLM was unavailable or rate-limited; fallback template was used."
		if retry_seconds is not None:
			notes += f" Suggested retry after {retry_seconds} seconds."

	return (
		f"# Business Requirements Document (BRD)\n\n"
		f"## Executive Summary\n"
		f"This BRD draft is generated from uploaded project artifacts for **{project_name}**.\n\n"
		f"## Business Objectives\n"
		"- Define and align stakeholder expectations.\n"
		"- Capture functional and non-functional requirements.\n"
		"- Establish acceptance criteria for delivery readiness.\n\n"
		"## Scope\n"
		"### In Scope\n"
		"- Requirements derived from uploaded documents and transcripts.\n"
		"- Clarification of key constraints, assumptions, and dependencies.\n\n"
		"### Out of Scope\n"
		"- Implementation-level technical design details.\n"
		"- Production deployment plan and release governance specifics.\n\n"
		"## Functional Requirements\n"
		"- FR1: System shall support end-to-end capture and processing of project inputs.\n"
		"- FR2: System shall provide traceable requirement outputs in BRD format.\n"
		"- FR3: System shall allow iterative updates based on stakeholder feedback.\n\n"
		"## Non-Functional Requirements\n"
		"- NFR1: Ensure data integrity for uploaded and generated documents.\n"
		"- NFR2: Maintain acceptable response times for BRD generation workflow.\n"
		"- NFR3: Ensure controlled access to project documents and generated outputs.\n\n"
		"## Assumptions\n"
		"- Uploaded source documents are complete and relevant.\n"
		"- Stakeholders will review and refine generated requirements.\n\n"
		"## Risks\n"
		"- Missing or ambiguous source inputs may reduce BRD quality.\n"
		"- External LLM/API availability can affect generation quality/latency.\n\n"
		"## Dependencies\n"
		"- Availability of OCR and embedding services.\n"
		"- Availability of LLM provider quotas and API access.\n\n"
		"## Acceptance Criteria\n"
		"- BRD includes all mandatory sections.\n"
		"- Requirements are testable and mapped to business objectives.\n"
		"- Stakeholder review comments are incorporated in subsequent revisions.\n\n"
		"## Source Context Excerpt\n"
		f"{trimmed_context or 'No context available.'}\n\n"
		+ (f"## Generation Note\n{notes}\n" if notes else "")
	)


def _sanitize_context(context: str, max_chars: int = 8000) -> str:
	"""
	Strip binary/non-printable content that leaks from DOCX/PDF byte extraction,
	then truncate to a safe token budget.
	"""
	# Remove runs of non-printable / binary-looking characters
	cleaned = re.sub(r"[^\x09\x0A\x0D\x20-\x7E\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+", " ", context)
	# Collapse excessive whitespace
	cleaned = re.sub(r"[ \t]{4,}", "   ", cleaned)
	cleaned = re.sub(r"\n{4,}", "\n\n\n", cleaned)
	cleaned = cleaned.strip()
	if len(cleaned) > max_chars:
		cleaned = cleaned[:max_chars] + "\n\n[...context truncated for length...]"
	return cleaned


def _analyze_context_node(state: BRDState) -> BRDState:
	clean_context = _sanitize_context(state["context"])

	prompt = f"""You are a senior business analyst. Your only job right now is to READ and EXTRACT information from the project materials below.

DO NOT summarize these instructions back to me.
DO NOT describe what a BRD is.
DO NOT echo back the prompt.

Instead, output a structured extraction under these exact headings:

BUSINESS GOALS:
<list the real goals found in the text>

STAKEHOLDERS:
<list names, roles, or teams mentioned>

REQUIREMENTS IDENTIFIED:
<list any explicit or implied requirements from the materials>

CONSTRAINTS AND RISKS:
<list constraints, risks, or concerns mentioned>

OPEN ISSUES:
<list any unresolved decisions or action items>

---
Project Name: {state['project_name']}

Source Materials:
{clean_context}
"""
	analysis = _ollama_generate(prompt, temperature=0.1)
	return {**state, "analysis": str(analysis), "context": clean_context}


def _draft_brd_node(state: BRDState) -> BRDState:
	# Use the analysis output plus the cleaned context — NOT a prompt description
	analysis = state.get("analysis", "").strip()
	clean_context = state.get("context", "").strip()

	# Further trim context for the drafting step so total prompt stays manageable
	context_excerpt = clean_context[:3500] + ("\n\n[...truncated...]" if len(clean_context) > 3500 else "")
	analysis_excerpt = analysis[:2000] + ("\n\n[...truncated...]" if len(analysis) > 2000 else "")

	prompt = f"""You are an expert Business Analyst writing a formal Business Requirements Document (BRD).

CRITICAL RULES — READ BEFORE WRITING:
1. DO NOT summarize or describe these instructions.
2. DO NOT say "I will create a BRD" or describe what you are about to do.
3. DO NOT echo back any part of this prompt.
4. START your response immediately with: # Business Requirements Document
5. Write ONLY the BRD content — nothing else.
6. Every section heading must be followed by real content extracted from the materials below.
7. Mark missing information as [TBD - Pending stakeholder input] rather than inventing data.
8. If the source materials are thin, write concise but honest sections using what is available.

---

PROJECT NAME: {state['project_name']}

EXTRACTED ANALYSIS (use this as your primary source of requirements):
{analysis_excerpt}

ORIGINAL SOURCE MATERIALS (for additional detail):
{context_excerpt}

---

Now write the complete BRD using EXACTLY this structure. Start immediately with the heading.

# Business Requirements Document

**Project Name:** {state['project_name']}
**Version:** 1.0
**Date:** [Extract from materials or mark TBD]
**Prepared By:** [Extract from materials or mark TBD]
**Status:** Draft

---

## 1. Executive Summary

[Write 2–3 sentences describing what this project is, what business problem it solves, and what outcome it delivers. Use the extracted analysis above.]

---

## 2. Project Overview

### 2.1 Background
[Describe the context and history of this initiative based on the source materials.]

### 2.2 Objectives
[List 3–6 specific, measurable objectives extracted from the materials.]

### 2.3 Scope

**In Scope:**
[List what is included.]

**Out of Scope:**
[List what is excluded.]

### 2.4 Assumptions
[List assumptions found in the materials.]

### 2.5 Constraints
[List technical, budget, regulatory, or timeline constraints.]

### 2.6 Dependencies
[List internal and external dependencies.]

---

## 3. Stakeholders

| Stakeholder | Role | Responsibility |
|-------------|------|----------------|
[Fill from extracted analysis. Use [TBD] for missing fields.]

---

## 4. Business Requirements

[For each requirement extracted, use this format:]

**BR-001** – [Requirement Title]
- Description: [What the business needs]
- Priority: High / Medium / Low
- Source: [Document or meeting it came from]
- Acceptance Criteria: [How we verify this is met]

[Continue BR-002, BR-003, etc.]

---

## 5. Functional Requirements

**FR-001** – [Requirement Title]
- Description: [What the system or process must do]
- Related BR: BR-001
- Priority: High / Medium / Low
- Acceptance Criteria: [Specific, testable criteria]

[Continue FR-002, FR-003, etc.]

---

## 6. Non-Functional Requirements

### 6.1 Performance
[Describe performance needs.]

### 6.2 Security
[Describe security needs.]

### 6.3 Scalability
[Describe scalability needs.]

### 6.4 Availability
[Describe uptime or reliability needs.]

### 6.5 Compliance
[List regulatory or compliance requirements if any.]

---

## 7. Risks and Mitigation

| Risk ID | Description | Likelihood | Impact | Mitigation |
|---------|-------------|------------|--------|------------|
[Fill from extracted analysis.]

---

## 8. Open Issues and Action Items

| Issue ID | Description | Owner | Due Date | Status |
|----------|-------------|-------|----------|--------|
[Fill from extracted analysis.]

---

## 9. Glossary

| Term | Definition |
|------|------------|
[Define key terms found in the materials.]

---

## 10. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | [Date] | [Author] | Initial Draft |

"""
	brd_markdown = _ollama_generate(prompt, temperature=0.15)

	# Safety check: if the model still echoed the prompt, detect and raise
	bad_phrases = [
		"you have provided a clear",
		"i will create a brd",
		"as an expert business analyst",
		"to summarize, the brd will be structured",
		"your task is to analyze all provided",
	]
	lower = brd_markdown.lower()
	if any(phrase in lower for phrase in bad_phrases) or not brd_markdown.strip().startswith("#"):
		# Try once more with a harder constraint
		brd_markdown = _retry_draft_with_strict_prompt(state["project_name"], analysis_excerpt, context_excerpt)

	return {**state, "brd_markdown": str(brd_markdown)}


def _retry_draft_with_strict_prompt(project_name: str, analysis: str, context: str) -> str:
	"""Last-resort retry with an ultra-direct prompt for models that keep echoing."""
	prompt = f"""WRITE THE FOLLOWING DOCUMENT. BEGIN WITH THE FIRST LINE BELOW. DO NOT ADD ANY PREAMBLE.

# Business Requirements Document

**Project Name:** {project_name}
**Version:** 1.0
**Status:** Draft

## 1. Executive Summary

Based on the project materials for {project_name}:
{analysis[:800]}

## 2. Project Overview

### 2.1 Background
{context[:400]}

### 2.2 Objectives
- [TBD - Pending stakeholder input]

### 2.3 Scope
**In Scope:** [TBD]
**Out of Scope:** [TBD]

### 2.4 Assumptions
- [TBD - Pending stakeholder input]

### 2.5 Constraints
- [TBD - Pending stakeholder input]

## 3. Stakeholders
| Stakeholder | Role | Responsibility |
|-------------|------|----------------|
| [TBD] | [TBD] | [TBD] |

## 4. Business Requirements
**BR-001** – Primary Business Requirement
- Description: {analysis[:300]}
- Priority: High
- Acceptance Criteria: [TBD]

## 5. Functional Requirements
**FR-001** – Core Functional Requirement
- Description: [TBD - Pending stakeholder input]
- Priority: High
- Acceptance Criteria: [TBD]

## 6. Non-Functional Requirements
### 6.1 Performance
[TBD]
### 6.2 Security
[TBD]

## 7. Risks and Mitigation
| Risk ID | Description | Likelihood | Impact | Mitigation |
|---------|-------------|------------|--------|------------|
| R-001 | [TBD] | Medium | High | [TBD] |

## 8. Open Issues
| Issue ID | Description | Owner | Status |
|----------|-------------|-------|--------|
| OI-001 | [TBD] | [TBD] | Open |

## 9. Glossary
| Term | Definition |
|------|------------|
| BRD | Business Requirements Document |

## 10. Document History
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | TBD | TBD | Initial Draft |

Now EXTEND and IMPROVE each section above using all details available in the project materials. Replace every [TBD] you can with real content from: {analysis[:1200]}
"""
	return _ollama_generate(prompt, temperature=0.1)


def run_brd_workflow(project_name: str, context: str) -> str:
	try:
		state: BRDState = {
			"project_name": project_name,
			"context": context,
			"analysis": "",
			"brd_markdown": "",
		}
		state = _analyze_context_node(state)
		state = _draft_brd_node(state)
	except Exception as exc:
		message = str(exc)
		if _is_quota_error(message):
			raise LLMQuotaError(message) from exc
		if isinstance(exc, LLMQuotaError):
			raise
		raise
	return state.get("brd_markdown", "")