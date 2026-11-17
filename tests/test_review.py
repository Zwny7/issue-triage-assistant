import unittest
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import create_app


class TestReview(unittest.TestCase):
    def test_legacy_approved_row_keeps_decision(self):
        with TemporaryDirectory() as folder:
            data = Path(folder)
            with closing(sqlite3.connect(data / "issues.sqlite3")) as conn, conn:
                conn.execute("""
                    CREATE TABLE triage (
                        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
                        title TEXT NOT NULL, body TEXT NOT NULL, result TEXT NOT NULL,
                        status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
                    )
                """)
                conn.execute("INSERT INTO triage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                    "legacy", str(uuid4()), "old-hash", "旧版闪退", "旧记录",
                    json.dumps({"label": "bug", "reason": "闪退", "missing": [],
                                "related": [], "tools": [], "source": "rules"}),
                    "approved", "2026-11-10 01:00:00", "2026-11-10 01:05:00",
                ))
            with TestClient(create_app(data)) as client:
                saved = client.get("/api/issues/legacy").json()
                self.assertEqual(saved["status"], "approved")
                self.assertEqual([event["event"] for event in saved["events"]], ["pending", "approved"])
                self.assertEqual(saved["events"][-1]["label"], "bug")
                self.assertEqual(saved["events"][-1]["occurred_at"], "2026-11-10 01:05:00")
                self.assertEqual(client.post("/api/issues/legacy/decision", json={"status": "approved"}).status_code, 200)

    def test_import_search_review_and_restart(self):
        with TemporaryDirectory() as folder:
            data = Path(folder)
            with TestClient(create_app(data)) as client:
                sample = {"id": "LOCAL-71", "title": "角标渲染错误 BX-591", "body": "旧版客户端出现偏移"}
                self.assertEqual(client.post("/api/issues/import", json={"items": [sample, sample]}).status_code, 422)
                self.assertEqual(client.post("/api/issues/import", json={"items": [sample]}).json()["available"], 6)
                sample["body"] = "新记录：工具栏角标偏移"
                self.assertEqual(client.post("/api/issues/import", json={"items": [sample]}).json()["available"], 6)
                payload = {"title": "角标渲染错误 BX-591", "body": "刷新后出现异常", "request_id": str(uuid4())}
                record = client.post("/api/issues", json=payload).json()
                self.assertEqual(record["result"]["related"][0]["body"], sample["body"])
                self.assertEqual(record["result"]["label"], "bug")
                self.assertEqual(record["result"]["tools"], [])
                endpoint = f"/api/issues/{record['id']}/decision"
                with ThreadPoolExecutor(max_workers=2) as pool:
                    responses = list(pool.map(lambda _: client.post(endpoint, json={
                        "status": "approved", "label": "question", "note": "复核后归为使用咨询",
                    }), range(2)))
                self.assertEqual([r.status_code for r in responses], [200, 200])
                self.assertEqual(len(responses[0].json()["events"]), 2)
                self.assertEqual(client.post(endpoint, json={"status": "rejected"}).status_code, 409)
                self.assertEqual(client.post(endpoint, json={"status": "approved", "label": "feature"}).status_code, 409)
            with TestClient(create_app(data)) as restarted:
                saved = restarted.get(f"/api/issues/{record['id']}").json()
                self.assertEqual(saved["result"]["label"], "bug")
                self.assertEqual(saved["events"][-1]["label"], "question")
                self.assertEqual(saved["events"][-1]["note"], "复核后归为使用咨询")
                self.assertEqual(restarted.get("/api/status").json()["resolved_count"], 6)
