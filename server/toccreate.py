from __future__ import annotations

import json
import os
import re
import socket
from typing import TypedDict
from urllib import error, request


class TocSection(TypedDict):
	number: str
	title: str
	description: str


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


def _trim_context(context: str, max_chars: int = 16000) -> str:
	value = (context or "").strip()
	if len(value) <= max_chars:
		return value
	return value[:max_chars] + "\n\n[...truncated for length...]"


def _sanitize_context(context: str, max_chars: int = 10000) -> str:
	"""Strip binary/non-printable content that leaks from DOCX/PDF byte extraction."""
	cleaned = re.sub(r"[^\x09\x0A\x0D\x20-\x7E\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]+", " ", context)
	cleaned = re.sub(r"[ \t]{4,}", "   ", cleaned)
	cleaned = re.sub(r"\n{4,}", "\n\n\n", cleaned)
	cleaned = cleaned.strip()
	if len(cleaned) > max_chars:
		cleaned = cleaned[:max_chars] + "\n\n[...truncated...]"
	return cleaned


def _strip_code_fences(text: str) -> str:
	value = text.strip()
	if value.startswith("```"):
		value = value.split("\n", 1)[1] if "\n" in value else ""
	if value.endswith("```"):
		value = value.rsplit("```", 1)[0].strip()
	return value


def _generate(prompt: str, temperature: float = 0.2) -> str:
	url = f"{_ollama_base_url()}/api/generate"
	body = json.dumps(
		{
			"model": _ollama_model(),
			"prompt": prompt,
			"stream": False,
			"options": {
				"temperature": temperature,
			},
		}
	).encode("utf-8")

	req = request.Request(
		url=url,
		data=body,
		headers={"Content-Type": "application/json"},
		method="POST",
	)

	try:
		with request.urlopen(req, timeout=_ollama_timeout_seconds()) as response:
			payload = json.loads(response.read().decode("utf-8"))
	except (TimeoutError, socket.timeout) as exc:
		raise RuntimeError("Local LLM request timed out. Increase OLLAMA_TIMEOUT_SEC.") from exc
	except error.URLError as exc:
		reason = str(getattr(exc, "reason", "")).lower()
		if "timed out" in reason:
			raise RuntimeError("Local LLM request timed out. Increase OLLAMA_TIMEOUT_SEC.") from exc
		raise RuntimeError("Local LLM is not reachable. Start Ollama and pull the configured model.") from exc
	except json.JSONDecodeError as exc:
		raise RuntimeError("Local LLM returned invalid JSON") from exc

	text = str(payload.get("response", "")).strip()
	if not text:
		raise RuntimeError("Local LLM returned empty response")
	return text


def _fallback_sections(project_name: str) -> list[TocSection]:
	"""Clean fallback that does NOT dump raw context into descriptions."""
	base = [
		("1.", "Executive Summary", f"High-level overview of the {project_name} initiative, business problem, and expected outcomes."),
		("2.", "Project Overview", f"Background, objectives, scope (in/out), assumptions, constraints, and dependencies for {project_name}."),
		("3.", "Stakeholders", "Identification of all stakeholders, their roles, responsibilities, and contact information."),
		("4.", "Business Requirements", "Enumerated business-level requirements (BR-001, BR-002, ...) with priority, source, and acceptance criteria."),
		("5.", "Functional Requirements", "Detailed functional requirements (FR-001, FR-002, ...) mapped to business requirements."),
		("6.", "Non-Functional Requirements", "Performance, security, scalability, availability, compliance, and usability requirements."),
		("7.", "Process Flows / Use Cases", "Key use cases and process flows with actors, pre/post conditions, and main/alternate flows."),
		("8.", "Data Requirements", "Data entities, sources, migration needs, and integration touchpoints."),
		("9.", "Risks and Mitigation", "Risk register with likelihood, impact, mitigation strategy, and owner for each identified risk."),
		("10.", "Open Issues and Action Items", "Unresolved decisions, pending approvals, and outstanding action items with owners and due dates."),
		("11.", "Glossary", "Definitions of all technical terms, acronyms, and domain-specific language used in this document."),
		("12.", "Approvals", "Sign-off table for stakeholder and sponsor approval of this BRD."),
	]

	return [
		TocSection(number=num, title=title, description=desc)
		for num, title, desc in base
	]


def suggest_toc_sections(project_name: str, context: str) -> list[TocSection]:
	clean_context = _sanitize_context(context, max_chars=10000)
	trimmed_context = _trim_context(clean_context, max_chars=10000)

	prompt = f"""You are a senior business analyst creating a Table of Contents for a Business Requirements Document (BRD).

IMPORTANT RULES:
- DO NOT describe what a BRD is.
- DO NOT echo back these instructions.
- DO NOT say "I will create" or "based on your request".
- Output ONLY valid JSON. Nothing else. No preamble, no explanation.

Read the source materials below and output a JSON object with a "sections" array.
Each section must have: "number" (like "1."), "title" (short, business-oriented), "description" (2-3 sentences synthesized from the source materials — specific to THIS project).

Required schema:
{{"sections": [{{"number": "1.", "title": "...", "description": "..."}}]}}

Rules:
- Between 8 and 12 sections
- Descriptions must reference actual content from the source materials
- Do not invent data not present in the materials

Project: {project_name}

Source Materials:
{trimmed_context}

Output only the JSON object now:"""

	try:
		raw = _generate(prompt, temperature=0.1)
		response = _strip_code_fences(raw)

		# Extract JSON even if the model added text around it
		json_match = re.search(r'\{[\s\S]*"sections"[\s\S]*\}', response)
		if json_match:
			response = json_match.group(0)

		parsed = json.loads(response)
		sections = parsed.get("sections", [])

		if not isinstance(sections, list) or len(sections) == 0:
			return _fallback_sections(project_name)

		normalized: list[TocSection] = []
		for idx, section in enumerate(sections, start=1):
			title = str(section.get("title", "")).strip()
			description = str(section.get("description", "")).strip()
			number = str(section.get("number", f"{idx}."))

			if not title:
				continue

			# Reject descriptions that look like echoed instructions
			bad_desc_phrases = ["you have provided", "i will create", "to summarize", "as an expert"]
			if any(phrase in description.lower() for phrase in bad_desc_phrases):
				description = f"[TBD - Pending stakeholder input for {title}]"

			number = f"{idx}." if not number.endswith(".") else number
			normalized.append(
				TocSection(
					number=number,
					title=title,
					description=description or f"Content for {title} section.",
				)
			)

		return normalized or _fallback_sections(project_name)

	except Exception:
		return _fallback_sections(project_name)


def refine_toc_section(
	project_name: str,
	section_title: str,
	current_description: str,
	instruction: str,
	context: str,
) -> str:
	clean_context = _sanitize_context(context, max_chars=6000)

	prompt = f"""You are a business analyst rewriting one section of a BRD.

RULES:
- DO NOT echo back these instructions or describe what you are doing.
- DO NOT output markdown headings.
- START your response immediately with the rewritten section text.
- Write in formal business language.
- Use only information from the source materials and the current draft.
- If information is missing, write [TBD - Pending stakeholder input].

Project: {project_name}
Section: {section_title}

Current Draft:
{current_description.strip() or "[Empty - write from scratch using source materials]"}

User Instruction:
{instruction.strip()}

Source Materials:
{clean_context}

Rewritten section text (start immediately, no preamble):"""

	try:
		result = _generate(prompt, temperature=0.2).strip()

		# Reject echoed instructions
		bad_phrases = ["you have provided", "i will rewrite", "as requested", "based on your instruction"]
		if result and not any(phrase in result.lower() for phrase in bad_phrases):
			return result
	except Exception:
		pass

	# Fallback: return current with instruction appended as note
	base = current_description.strip()
	note = f"\n\n[Revision requested: {instruction.strip()}]"
	return base + note if base else note