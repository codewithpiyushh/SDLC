import os
import json
from datetime import datetime
from pathlib import Path

import mysql.connector
from dotenv import load_dotenv
from mysql.connector import Error


ROOT_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
load_dotenv(ROOT_ENV_PATH)


def _mysql_config() -> dict:
	return {
		"host": os.getenv("MYSQL_HOST", "localhost"),
		"port": int(os.getenv("MYSQL_PORT", "3306")),
		"user": os.getenv("MYSQL_USER", "root"),
		"password": os.getenv("MYSQL_PASSWORD", ""),
		"database": os.getenv("MYSQL_DATABASE", "sdlc"),
	}


def get_connection():
	return mysql.connector.connect(**_mysql_config())


def _get_project_columns(conn) -> set[str]:
	config = _mysql_config()
	with conn.cursor() as cursor:
		cursor.execute(
			"""
			SELECT COLUMN_NAME
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE TABLE_SCHEMA = %s AND TABLE_NAME = 'projects'
			""",
			(config["database"],),
		)
		return {row[0] for row in cursor.fetchall()}


def _detect_projects_schema(conn) -> str:
	columns = _get_project_columns(conn)

	canonical = {"name", "field", "pdf_name"}
	legacy = {"project_name", "project_field", "pdf_file_name"}

	if canonical.issubset(columns):
		return "canonical"

	if legacy.issubset(columns):
		return "legacy"

	raise Error("Unsupported projects table schema. Expected canonical or legacy column set.")


def init_db() -> None:
	config = _mysql_config()
	db_name = config["database"]

	base_config = dict(config)
	base_config.pop("database", None)

	with mysql.connector.connect(**base_config) as admin_conn:
		with admin_conn.cursor() as cursor:
			cursor.execute(f"CREATE DATABASE IF NOT EXISTS `{db_name}`")

	with get_connection() as conn:
		with conn.cursor() as cursor:
			cursor.execute(
				"""
				CREATE TABLE IF NOT EXISTS projects (
					id INT AUTO_INCREMENT PRIMARY KEY,
					name VARCHAR(255) NOT NULL,
					created_by VARCHAR(255) NOT NULL,
					created_on DATETIME NOT NULL,
					description TEXT NOT NULL,
					field VARCHAR(64) NOT NULL,
					pdf_name VARCHAR(255) NOT NULL
				)
				"""
			)
			cursor.execute(
				"""
				CREATE TABLE IF NOT EXISTS project_versions (
					id INT AUTO_INCREMENT PRIMARY KEY,
					project_id INT NOT NULL,
					source VARCHAR(32) NOT NULL,
					created_by VARCHAR(255) NOT NULL,
					created_on DATETIME NOT NULL,
					snapshot_json LONGTEXT NOT NULL,
					INDEX idx_project_versions_project (project_id)
				)
				"""
			)
			cursor.execute(
				"""
				CREATE TABLE IF NOT EXISTS project_documents (
					project_id INT NOT NULL,
					mom_file VARCHAR(255) DEFAULT NULL,
					pre_documents_file VARCHAR(255) DEFAULT NULL,
					transcripts_file VARCHAR(255) DEFAULT NULL,
					final_brd_file VARCHAR(255) DEFAULT NULL,
					uploaded_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
					updated_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
					PRIMARY KEY (project_id)
				)
				"""
			)
		conn.commit()


def create_project(name: str, created_by: str, description: str, field: str, pdf_name: str) -> dict:
	created_on = datetime.utcnow()

	with get_connection() as conn:
		schema = _detect_projects_schema(conn)
		with conn.cursor() as cursor:
			if schema == "legacy":
				cursor.execute(
					"""
					INSERT INTO projects (project_name, created_by, created_on, description, project_field, pdf_file_name)
					VALUES (%s, %s, %s, %s, %s, %s)
					""",
					(name, created_by, created_on, description, field, pdf_name),
				)
			else:
				cursor.execute(
					"""
					INSERT INTO projects (name, created_by, created_on, description, field, pdf_name)
					VALUES (%s, %s, %s, %s, %s, %s)
					""",
					(name, created_by, created_on, description, field, pdf_name),
				)
			project_id = cursor.lastrowid
		conn.commit()

	return {
		"id": project_id,
		"name": name,
		"createdBy": created_by,
		"createdOn": created_on.isoformat(),
		"description": description,
		"field": field,
		"pdfName": pdf_name,
	}


def list_projects() -> list[dict]:
	with get_connection() as conn:
		schema = _detect_projects_schema(conn)
		with conn.cursor(dictionary=True) as cursor:
			if schema == "legacy":
				cursor.execute(
					"""
					SELECT
						id,
						project_name AS name,
						created_by,
						created_on,
						description,
						project_field AS field,
						pdf_file_name AS pdf_name
					FROM projects
					ORDER BY id DESC
					"""
				)
			else:
				cursor.execute(
					"""
					SELECT id, name, created_by, created_on, description, field, pdf_name
					FROM projects
					ORDER BY id DESC
					"""
				)
			rows = cursor.fetchall()

	return [
		{
			"id": row["id"],
			"name": row["name"],
			"createdBy": row["created_by"],
			"createdOn": row["created_on"].isoformat(),
			"description": row["description"],
			"field": row["field"],
			"pdfName": row["pdf_name"],
		}
		for row in rows
	]


def get_project(project_id: int) -> dict | None:
	with get_connection() as conn:
		schema = _detect_projects_schema(conn)
		with conn.cursor(dictionary=True) as cursor:
			if schema == "legacy":
				cursor.execute(
					"""
					SELECT
						id,
						project_name AS name,
						created_by,
						created_on,
						description,
						project_field AS field,
						pdf_file_name AS pdf_name
					FROM projects
					WHERE id = %s
					""",
					(project_id,),
				)
			else:
				cursor.execute(
					"""
					SELECT id, name, created_by, created_on, description, field, pdf_name
					FROM projects
					WHERE id = %s
					""",
					(project_id,),
				)
			row = cursor.fetchone()

	if not row:
		return None

	return {
		"id": row["id"],
		"name": row["name"],
		"createdBy": row["created_by"],
		"createdOn": row["created_on"].isoformat(),
		"description": row["description"],
		"field": row["field"],
		"pdfName": row["pdf_name"],
	}


def delete_project(project_id: int) -> bool:
	with get_connection() as conn:
		with conn.cursor() as cursor:
			cursor.execute("DELETE FROM projects WHERE id = %s", (project_id,))
			deleted = cursor.rowcount > 0
		conn.commit()
	return deleted


def ping_database() -> bool:
	try:
		with get_connection() as conn:
			conn.ping(reconnect=False, attempts=1, delay=0)
		return True
	except Error:
		return False


def save_project_version(project_id: int, source: str, created_by: str, snapshot: dict) -> dict:
	created_on = datetime.utcnow()

	with get_connection() as conn:
		with conn.cursor(dictionary=True) as cursor:
			cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
			project_row = cursor.fetchone()
			if not project_row:
				raise Error("Project not found")

			cursor.execute(
				"""
				INSERT INTO project_versions (project_id, source, created_by, created_on, snapshot_json)
				VALUES (%s, %s, %s, %s, %s)
				""",
				(project_id, source, created_by, created_on, json.dumps(snapshot)),
			)
			version_id = cursor.lastrowid
		conn.commit()

	return {
		"id": version_id,
		"projectId": project_id,
		"source": source,
		"createdBy": created_by,
		"createdOn": created_on.isoformat(),
		"snapshot": snapshot,
	}


def list_project_versions(project_id: int) -> list[dict]:
	with get_connection() as conn:
		with conn.cursor(dictionary=True) as cursor:
			cursor.execute(
				"""
				SELECT id, project_id, source, created_by, created_on, snapshot_json
				FROM project_versions
				WHERE project_id = %s
				ORDER BY id DESC
				""",
				(project_id,),
			)
			rows = cursor.fetchall()

	return [
		{
			"id": row["id"],
			"projectId": row["project_id"],
			"source": row["source"],
			"createdBy": row["created_by"],
			"createdOn": row["created_on"].isoformat(),
			"snapshot": json.loads(row["snapshot_json"]),
		}
		for row in rows
	]


def save_project_document_file(project_id: int, document_type: str, file_name: str) -> dict:
	column_map = {
		"mom": "mom_file",
		"pre_documents": "pre_documents_file",
		"transcripts": "transcripts_file",
		"final_brd": "final_brd_file",
	}

	if document_type not in column_map:
		raise Error("Unsupported document type")

	column_name = column_map[document_type]

	with get_connection() as conn:
		with conn.cursor(dictionary=True) as cursor:
			cursor.execute("SELECT id FROM projects WHERE id = %s", (project_id,))
			project_row = cursor.fetchone()
			if not project_row:
				raise Error("Project not found")

			cursor.execute(
				f"""
				INSERT INTO project_documents (project_id, {column_name})
				VALUES (%s, %s)
				ON DUPLICATE KEY UPDATE {column_name} = VALUES({column_name})
				""",
				(project_id, file_name),
			)

			cursor.execute(
				"""
				SELECT project_id, mom_file, pre_documents_file, transcripts_file, final_brd_file, uploaded_on, updated_on
				FROM project_documents
				WHERE project_id = %s
				""",
				(project_id,),
			)
			row = cursor.fetchone()
		conn.commit()

	if not row:
		raise Error("Failed to save project document")

	return {
		"projectId": row["project_id"],
		"momFile": row["mom_file"],
		"preDocumentsFile": row["pre_documents_file"],
		"transcriptsFile": row["transcripts_file"],
		"finalBrdFile": row["final_brd_file"],
		"uploadedOn": row["uploaded_on"].isoformat(),
		"updatedOn": row["updated_on"].isoformat(),
	}


def get_project_documents(project_id: int) -> dict | None:
	with get_connection() as conn:
		with conn.cursor(dictionary=True) as cursor:
			cursor.execute(
				"""
				SELECT project_id, mom_file, pre_documents_file, transcripts_file, final_brd_file, uploaded_on, updated_on
				FROM project_documents
				WHERE project_id = %s
				""",
				(project_id,),
			)
			row = cursor.fetchone()

	if not row:
		return None

	return {
		"projectId": row["project_id"],
		"momFile": row["mom_file"],
		"preDocumentsFile": row["pre_documents_file"],
		"transcriptsFile": row["transcripts_file"],
		"finalBrdFile": row["final_brd_file"],
		"uploadedOn": row["uploaded_on"].isoformat(),
		"updatedOn": row["updated_on"].isoformat(),
	}
