import logging
import time
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import settings
from .issue_service import EXAMPLES, LABELS, DecisionStatus, HistoryImport, IssueConflict, IssueService, Label
from .model import ModelError

logger = logging.getLogger("uvicorn.error")


class Input(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class IssueInput(Input):
    title: str = Field(min_length=2, max_length=180)
    body: str = Field(default="", max_length=3500)
    request_id: UUID
    use_model: bool = False


class Decision(Input):
    status: DecisionStatus
    label: Label | None = None
    note: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def label_requires_approval(self):
        if self.status == "rejected" and self.label is not None:
            raise ValueError("驳回建议时不能设置最终标签")
        return self


def create_app(data=settings.DATA) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        data.mkdir(parents=True, exist_ok=True)
        app.state.issues = IssueService(data / "issues.sqlite3")
        yield

    app = FastAPI(title="Issue助手", version="1.0", lifespan=lifespan)
    web = settings.ROOT / "web"
    app.mount("/static", StaticFiles(directory=web), name="static")

    @app.middleware("http")
    async def request_log(request: Request, call_next):
        rid = uuid4().hex[:12]
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        logger.info("request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
                    rid, request.method, request.url.path, response.status_code,
                    (time.perf_counter() - started) * 1000)
        return response

    @app.exception_handler(ModelError)
    async def model_error(_request, error):
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.exception_handler(IssueConflict)
    async def conflict(_request, error):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.get("/", include_in_schema=False)
    def home():
        return FileResponse(web / "index.html")

    @app.get("/api/status")
    def status():
        return {"model_ready": settings.MODEL_READY, "labels": LABELS,
                "resolved_count": len(app.state.issues.corpus_snapshot[0])}

    @app.get("/api/issues/examples")
    def examples():
        return EXAMPLES["incoming"]

    @app.get("/api/issues/import-example")
    def import_example():
        return {"items": EXAMPLES["resolved"]}

    @app.post("/api/issues/import")
    def import_history(payload: HistoryImport):
        return app.state.issues.import_history(payload.items)

    @app.get("/api/issues")
    def history():
        return app.state.issues.recent()

    @app.post("/api/issues")
    def create_issue(payload: IssueInput):
        return app.state.issues.create(payload.title, payload.body, payload.use_model, str(payload.request_id))

    @app.get("/api/issues/{issue_id}")
    def issue_details(issue_id: str):
        try:
            return app.state.issues.get(issue_id)
        except LookupError as exc:
            raise HTTPException(404, "没有找到这条分诊记录。") from exc

    @app.post("/api/issues/{issue_id}/decision")
    def decide(issue_id: str, payload: Decision):
        try:
            return app.state.issues.decide(issue_id, payload.status, payload.label, payload.note)
        except LookupError as exc:
            raise HTTPException(404, "没有找到这条分诊记录。") from exc

    return app


app = create_app()
