const byId = (id) => document.getElementById(id);
const labels = { bug: "故障", feature: "功能建议", question: "使用咨询" };
const states = { pending: "待确认", approved: "已确认", rejected: "已驳回" };
let pendingRequest;
let selectedRecord = 0;
let recentRecords = [];

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function request(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const content = await response.json();
  if (!response.ok) {
    const detail = typeof content.detail === "string" ? content.detail : "请检查填写的内容。";
    throw new Error(detail);
  }
  return content;
}

function status(id, message, error = false) {
  const node = byId(id);
  node.textContent = message;
  node.classList.toggle("error", error);
}


async function loadHistory() {
  recentRecords = await request("/api/issues");
  renderHistory();
}

function renderHistory() {
  const filter = byId("history-filter").value;
  const rows = recentRecords.filter(record => filter === "all" || record.status === filter);
  const node = byId("history");
  node.replaceChildren();
  if (!rows.length) {
    node.append(element("p", filter === "all" ? "还没有分诊记录。" : "最近的记录里没有这个状态。", "muted"));
  }
  for (const record of rows) {
    const button = element("button", "", "secondary history-entry");
    button.type = "button";
    button.append(element("span", record.title), element("span", states[record.status]));
    button.addEventListener("click", async () => {
      const selection = ++selectedRecord;
      status("history-status", "正在加载分诊记录…");
      try {
        const details = await request(`/api/issues/${record.id}`);
        if (selection === selectedRecord) {
          renderIssue(details);
          status("history-status", "");
        }
      } catch (error) {
        if (selection === selectedRecord) status("history-status", error.message, true);
      }
    });
    node.append(button);
  }
}

byId("history-filter").addEventListener("change", renderHistory);

function renderIssue(record) {
  const node = byId("triage");
  const result = record.result;
  node.replaceChildren(
    element("h2", "分诊建议"),
    element("span", `${states[record.status]} · ${labels[result.label]} · ${result.source === "model" ? "大模型工具调用" : "规则分析"}`, "tag"),
    element("p", record.title, "detail"),
    element("p", result.reason, "muted"),
    element("h3", "需要补充的信息"),
  );
  if (result.missing.length) {
    const list = element("ul", "");
    for (const item of result.missing) list.append(element("li", item));
    node.append(list);
  } else node.append(element("p", "当前未发现需要补充的字段。", "muted"));
  node.append(element("h3", "相似历史问题"));
  if (!result.related.length) node.append(element("p", "没有找到匹配的历史问题。", "muted"));
  for (const issue of result.related) {
    const details = element("details", "");
    details.append(element("summary", `${issue.id} · ${issue.title}`), element("p", issue.body, "quote"));
    node.append(details);
  }
  if (result.source === "model") node.append(element("p", "已调用工具：" + result.tools.join("、"), "muted"));
  const timeline = element("details", "");
  timeline.open = record.status !== "pending";
  timeline.append(element("summary", "处理记录"));
  for (const event of record.events) {
    const caption = `${states[event.event]}${event.label ? " · " + labels[event.label] : ""} · ${event.occurred_at} UTC`;
    timeline.append(element("p", caption, "muted"));
    if (event.note) timeline.append(element("p", event.note, "quote"));
  }
  node.append(timeline);
  if (record.status !== "pending") return;
  const review = element("div", "", "row");
  const labelField = element("div", "", "field");
  const labelInput = element("select", "");
  const labelCaption = element("label", "最终标签");
  labelCaption.htmlFor = labelInput.id = "final-label";
  for (const [key, title] of Object.entries(labels)) labelInput.append(new Option(title, key));
  labelInput.value = result.label;
  labelField.append(labelCaption, labelInput);
  const noteField = element("div", "", "field");
  const noteInput = element("input", "");
  const noteCaption = element("label", "复核备注");
  noteCaption.htmlFor = noteInput.id = "review-note";
  noteInput.placeholder = "选填";
  noteInput.maxLength = 500;
  noteField.append(noteCaption, noteInput);
  review.append(labelField, noteField);
  const actions = element("div", "", "actions");
  const message = element("p", "", "status");
  message.setAttribute("role", "status");
  for (const [state, label] of [["approved", "确认建议"], ["rejected", "驳回建议"]]) {
    const button = element("button", label, state === "rejected" ? "secondary" : "");
    button.addEventListener("click", async () => {
      for (const action of actions.children) action.disabled = true;
      try {
        const updated = await request(`/api/issues/${record.id}/decision`, {
          status: state, label: state === "approved" ? labelInput.value : null, note: noteInput.value,
        });
        if (node.contains(actions)) renderIssue(updated);
        await loadHistory();
      } catch (error) {
        message.textContent = error.message;
        for (const action of actions.children) action.disabled = false;
      }
    });
    actions.append(button);
  }
  node.append(review, actions, message);
}

function handleForm(formId, messageId, loading, submit) {
  const form = byId(formId);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    status(messageId, loading);
    try {
      await submit();
      status(messageId, "");
    } catch (error) {
      status(messageId, error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}


handleForm("issue-form", "issue-status", "正在生成建议…", async () => {
  const input = { title: byId("title").value.trim(), body: byId("body").value.trim(),
    use_model: byId("analysis-mode").value === "model" };
  const key = JSON.stringify(input);
  if (pendingRequest?.key !== key) pendingRequest = { key, id: crypto.randomUUID() };
  const record = await request("/api/issues", { ...input, request_id: pendingRequest.id });
  pendingRequest = undefined;
  selectedRecord++;
  status("history-status", "");
  renderIssue(record);
  await loadHistory();
});

request("/api/status").then((info) => {
  byId("corpus-status").textContent = `可检索 ${info.resolved_count} 条历史问题。`;
  for (const id of ["analysis-mode"]) {
    const option = byId(id).querySelector('[value="model"]');
    option.disabled = !info.model_ready;
    if (!info.model_ready) option.textContent += "（需配置）";
  }
}).catch((error) => {
  status("issue-status", error.message, true);
});

request("/api/issues/examples").then((examples) => {
  for (const [index, example] of examples.entries()) {
    const button = element("button", ["同步异常", "功能建议", "信息不足"][index] || example.title, "chip");
    button.type = "button";
    button.addEventListener("click", () => {
      byId("title").value = example.title;
      byId("body").value = example.body;
      byId("title").focus();
    });
    byId("examples").append(button);
  }
}).catch((error) => status("issue-status", error.message, true));
loadHistory().catch((error) => status("issue-status", error.message, true));

byId("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = byId("import-file");
  const button = form.querySelector('[type="submit"]');
  if (button.disabled || !input.files.length) return;
  button.disabled = true;
  status("import-status", "正在导入…");
  try {
    const file = input.files[0];
    if (file.size > 3 * 1024 * 1024) throw new Error("文件超过 3 MB，请分批导入。");
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error("文件不是有效的 JSON，请参照示例格式。");
    }
    const result = await request("/api/issues/import", payload);
    byId("corpus-status").textContent = `可检索 ${result.available} 条历史问题。`;
    status("import-status", `已导入 ${result.imported} 条。已有编号按新内容更新。`);
    form.reset();
  } catch (error) {
    status("import-status", error.message, true);
  } finally {
    button.disabled = false;
  }
});
