import React, { useState, useEffect } from "react";
import { api, Field, Failure, useWords } from "./publisher.js";
const fields: Record<string, string[]> = {
  products: [
    "sku",
    "name_vi",
    "name_en",
    "aliases",
    "unit",
    "price",
    "currency",
    "stock_status",
    "stock_qty",
    "min_order",
    "notes_public",
    "updated_at",
    "price_updated_at",
    "stock_updated_at",
  ],
  shipping_zones: [
    "zone_name",
    "provinces",
    "fee",
    "free_over",
    "currency",
    "lead_time_hours_min",
    "lead_time_hours_max",
    "carrier",
    "cod_allowed",
    "notes_public",
    "updated_at",
  ],
  faq: [
    "id",
    "question_patterns",
    "answer_vi",
    "answer_en",
    "intent",
    "updated_at",
  ],
  policies: ["id", "topic", "answer_vi", "answer_en", "updated_at"],
  orders: [
    "order_id",
    "date",
    "customer",
    "phone",
    "items",
    "kg",
    "total",
    "currency",
    "lines",
    "status",
    "updated_at",
  ],
};
export function Knowledge() {
  const w = useWords();
  const [data, setData] = useState<any>({
    sources: [],
    records: [],
    syncs: [],
  });
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<any>(null);
  const [sourceName, setSourceName] = useState("");
  const [dataset, setDataset] = useState("products");
  const [kind, setKind] = useState("builtin");
  const [url, setUrl] = useState("");
  const [sheetId, setSheetId] = useState("");
  const [sheetRange, setSheetRange] = useState("Sheet1!A1:AZ10001");
  const [age, setAge] = useState(24);
  const [content, setContent] = useState("");
  const [format, setFormat] = useState("csv");
  const [preview, setPreview] = useState<any>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [row, setRow] = useState<Record<string, unknown>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  async function load() {
    try {
      setData(await api("/knowledge"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function choose(s: any) {
    setSelected(s);
    setContent("");
    setPreview(null);
    setMapping(s.mapping);
    setRow({
      updated_at: new Date().toISOString(),
      ...(s.dataset === "products"
        ? { unit: "kg", currency: "VND", stock_status: "in_stock" }
        : s.dataset === "shipping_zones"
          ? { currency: "VND", cod_allowed: false }
          : {}),
    });
    setEditingKey(null);
    setError("");
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api("/knowledge/sources", "POST", {
        name: sourceName,
        dataset,
        kind,
        maxAgeHours: age,
        ...(url ? { url } : {}),
        ...(kind === "google_api"
          ? { spreadsheetId: sheetId, range: sheetRange }
          : {}),
      });
      const next = await api("/knowledge");
      setData(next);
      choose(next.sources.find((s: any) => s.id === r.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function sync(rows?: unknown[]) {
    if (!selected) return;
    setError("");
    try {
      const result = await api(
        "/knowledge/" + selected.id + "/sync",
        "POST",
        rows ? { rows } : content ? { content, format, mapping } : {},
      );
      if (!result.ok) {
        setError(
          result.errors
            .map(
              (e: any) =>
                `${w("Row", "Dòng")} ${e.row}: ${e.fields.join(", ")} — ${e.message}`,
            )
            .join("\n"),
        );
        return;
      }
      await load();
      setPreview(null);
      setError(
        w(
          `Saved ${result.rows} rows; ${result.changed} changed. Source timestamps preserved.`,
          `Đã lưu ${result.rows} dòng; ${result.changed} thay đổi. Giữ nguyên thời gian nguồn.`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {w("THE PRICE BOARD", "BẢNG THÔNG TIN")}
          </span>
          <h1>{w("Knowledge sources", "Nguồn kiến thức")}</h1>
          <p>
            {w(
              "Approve facts with their original update times. Polling does not make old facts fresh.",
              "Duyệt dữ liệu kèm thời gian cập nhật gốc. Đồng bộ không làm dữ liệu cũ thành mới.",
            )}
          </p>
        </div>
      </div>
      <Failure error={error} />
      <div className="workspace-columns">
        <aside className="panel section">
          <h2>{w("Sources", "Nguồn")}</h2>
          {data.sources.map((s: any) => (
            <button
              className={
                "source-button " + (selected?.id === s.id ? "active" : "")
              }
              key={s.id}
              onClick={() => choose(s)}
            >
              <strong>{s.name}</strong>
              <small>
                {s.dataset} · {s.kind} · {s.status}
              </small>
            </button>
          ))}
          <details>
            <summary>{w("Add source", "Thêm nguồn")}</summary>
            <form onSubmit={create}>
              <Field label={w("Source name", "Tên nguồn")}>
                <input
                  required
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                />
              </Field>
              <Field label={w("Dataset", "Loại dữ liệu")}>
                <select
                  value={dataset}
                  onChange={(e) => setDataset(e.target.value)}
                >
                  {Object.keys(fields).map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </Field>
              <Field label={w("Source type", "Loại nguồn")}>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {["builtin", "csv", "xlsx", "google_csv", "google_api"].map(
                    (d) => (
                      <option key={d}>{d}</option>
                    ),
                  )}
                </select>
              </Field>
              {kind === "google_csv" && (
                <Field
                  label={w(
                    "Published Google CSV URL",
                    "URL Google CSV công khai",
                  )}
                >
                  <input
                    type="url"
                    required
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </Field>
              )}
              {kind === "google_api" && (
                <>
                  <Field label={w("Spreadsheet ID", "ID bảng tính")}>
                    <input
                      required
                      value={sheetId}
                      onChange={(e) => setSheetId(e.target.value)}
                    />
                  </Field>
                  <Field label={w("Range", "Vùng dữ liệu")}>
                    <input
                      required
                      value={sheetRange}
                      onChange={(e) => setSheetRange(e.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field label={w("Maximum age (hours)", "Thời hạn dữ liệu (giờ)")}>
                <input
                  type="number"
                  min={0.1}
                  step="any"
                  max={8760}
                  value={age}
                  onChange={(e) => setAge(+e.target.value)}
                />
              </Field>
              <button className="primary">
                {w("Create source", "Tạo nguồn")}
              </button>
            </form>
          </details>
        </aside>
        <section className="panel section">
          {selected ? (
            <>
              <h2>{selected.name}</h2>
              <p>
                {w(
                  "Importing confirms these facts as approved business data. A rejected import leaves the previous version active.",
                  "Nhập dữ liệu xác nhận đây là dữ liệu doanh nghiệp đã duyệt. Nếu bị từ chối, phiên bản trước vẫn hoạt động.",
                )}
              </p>
              {selected.kind === "builtin" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const existing = data.records
                      .filter(
                        (r: any) =>
                          r.source_id === selected.id &&
                          r.record_key !== editingKey,
                      )
                      .map((r: any) => r.data);
                    void sync([...existing, row]);
                  }}
                >
                  <div className="form-grid">
                    {fields[selected.dataset].map((f) => (
                      <Field label={f} key={f}>
                        {["notes_public", "answer_vi", "answer_en"].includes(
                          f,
                        ) ? (
                          <textarea
                            rows={3}
                            value={String(row[f] ?? "")}
                            onChange={(e) =>
                              setRow({ ...row, [f]: e.target.value })
                            }
                          />
                        ) : (
                          <input
                            value={
                              Array.isArray(row[f])
                                ? f === "lines"
                                  ? JSON.stringify(row[f])
                                  : (row[f] as string[]).join(";")
                                : String(row[f] ?? "")
                            }
                            placeholder={
                              f === "updated_at"
                                ? "2026-09-09T06:00:00+07:00"
                                : ""
                            }
                            onChange={(e) =>
                              setRow({ ...row, [f]: e.target.value })
                            }
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <button className="primary">
                    {w("Approve & save record", "Duyệt & lưu dòng")}
                  </button>
                </form>
              ) : (
                <>
                  <Field label={w("Upload / replace file", "Tải / thay tệp")}>
                    <input
                      type="file"
                      accept=".csv,.xlsx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const fmt = file.name.endsWith(".xlsx")
                          ? "xlsx"
                          : "csv";
                        setFormat(fmt);
                        void (async () => {
                          let text;
                          if (fmt === "csv") text = await file.text();
                          else {
                            const bytes = new Uint8Array(
                              await file.arrayBuffer(),
                            );
                            let b = "";
                            for (const x of bytes) b += String.fromCharCode(x);
                            text = btoa(b);
                          }
                          setContent(text);
                          const p = await api("/knowledge/preview", "POST", {
                            dataset: selected.dataset,
                            format: fmt,
                            content: text,
                            mapping: {},
                          });
                          setPreview(p);
                          setMapping(
                            Object.fromEntries(
                              fields[selected.dataset].map((f) => [
                                f,
                                p.columns.includes(f) ? f : "",
                              ]),
                            ),
                          );
                        })().catch((e) => setError(e.message));
                      }}
                    />
                  </Field>
                  {preview && (
                    <>
                      <p>
                        {preview.rowCount}{" "}
                        {w(
                          "rows detected. Map columns before approving.",
                          "dòng được tìm thấy. Ánh xạ cột trước khi duyệt.",
                        )}
                      </p>
                      <div className="form-grid">
                        {fields[selected.dataset].map((f) => (
                          <Field key={f} label={f}>
                            <select
                              value={mapping[f] ?? ""}
                              onChange={(e) =>
                                setMapping({ ...mapping, [f]: e.target.value })
                              }
                            >
                              <option value="">
                                {w("Not mapped", "Không ánh xạ")}
                              </option>
                              {preview.columns.map((x: string) => (
                                <option key={x}>{x}</option>
                              ))}
                            </select>
                          </Field>
                        ))}
                      </div>
                      <pre className="payload">
                        {JSON.stringify(preview.rows.slice(0, 3), null, 2)}
                      </pre>
                      <button className="primary" onClick={() => void sync()}>
                        {w("Approve & import", "Duyệt & nhập")}
                      </button>
                    </>
                  )}
                  {["google_csv", "google_api"].includes(selected.kind) && (
                    <button onClick={() => void sync()}>
                      {w("Sync now", "Đồng bộ ngay")}
                    </button>
                  )}
                </>
              )}
              <h3>{w("Current records", "Dữ liệu hiện tại")}</h3>
              {data.records
                .filter((r: any) => r.source_id === selected.id)
                .map((r: any) => (
                  <details key={r.id}>
                    <summary>
                      {r.record_key} · v{r.version} · {r.data.updated_at}
                    </summary>
                    <pre className="payload">
                      {JSON.stringify(r.data, null, 2)}
                    </pre>
                    {selected.kind === "builtin" && (
                      <button
                        onClick={() => {
                          setRow(r.data);
                          setEditingKey(r.record_key);
                        }}
                      >
                        {w("Edit record", "Sửa dòng")}
                      </button>
                    )}
                  </details>
                ))}
            </>
          ) : (
            <div className="empty-state">
              {w(
                "Choose or add a knowledge source. No business facts are preloaded.",
                "Chọn hoặc thêm nguồn kiến thức. Chưa có dữ liệu kinh doanh mẫu.",
              )}
            </div>
          )}
        </section>
      </div>
      <section className="panel section">
        <h2>{w("Sync log", "Nhật ký đồng bộ")}</h2>
        {data.syncs.map((s: any) => (
          <p key={s.id}>
            {new Date(s.created_at).toLocaleString()} · {s.status} ·{" "}
            {s.row_count} {w("rows", "dòng")} · {s.changed_count}{" "}
            {w("changed", "thay đổi")}
            {s.error && <pre>{JSON.stringify(s.error)}</pre>}
          </p>
        ))}
      </section>
    </>
  );
}
export function Rules() {
  const w = useWords();
  const [yaml, setYaml] = useState("");
  const [version, setVersion] = useState(0);
  const [text, setText] = useState("");
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [voice, setVoice] = useState<any>(null);
  useEffect(() => {
    void Promise.all([api("/rules"), api("/voice")])
      .then(([r, v]) => {
        setYaml(r.yaml);
        setVersion(r.version);
        setVoice(v);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{w("Rules & voice", "Quy tắc & giọng văn")}</h1>
          <p>
            {w(
              "24/7 coverage. Complaints stay human-only and email-only.",
              "Hoạt động 24/7. Khiếu nại do người xử lý, chỉ thông báo email.",
            )}
          </p>
        </div>
      </div>
      <Failure error={error} />
      <div className="workspace-columns equal">
        <section className="panel section">
          <h2>
            {w("Versioned rules", "Quy tắc có phiên bản")} · v{version}
          </h2>
          <Field label="YAML">
            <textarea
              className="code-editor"
              rows={26}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
            />
          </Field>
          <button
            className="primary"
            onClick={() =>
              void api("/rules", "POST", { yaml, expectedVersion: version })
                .then((r) => setVersion(r.version))
                .catch((e) => setError(e.message))
            }
          >
            {w("Approve new rules revision", "Duyệt phiên bản quy tắc mới")}
          </button>
        </section>
        <section className="panel section">
          <h2>{w("Test a message", "Thử tin nhắn")}</h2>
          <p>
            {w(
              "Offline conservative preview; this is not a real-model accuracy evaluation and sends nothing.",
              "Xem thử bảo thủ ngoại tuyến; không đánh giá độ chính xác mô hình thực, không gửi tin.",
            )}
          </p>
          <Field label={w("Customer inquiry", "Câu hỏi khách hàng")}>
            <textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <button
            onClick={() =>
              void api("/rules/test", "POST", { text })
                .then(setResult)
                .catch((e) => setError(e.message))
            }
          >
            {w("Run preview", "Chạy thử")}
          </button>
          {result && (
            <>
              <p>{result.text}</p>
              <pre className="payload">{JSON.stringify(result, null, 2)}</pre>
            </>
          )}
        </section>
      </div>
      {voice && (
        <section className="panel section">
          <h2>
            {w("Approved brand voice", "Giọng văn đã duyệt")} · v{voice.version}
          </h2>
          <div className="form-grid">
            {Object.entries(voice.config)
              .filter(([, v]) => typeof v === "string")
              .map(([key, val]) => (
                <Field key={key} label={key}>
                  <textarea
                    rows={key === "samples_md" ? 6 : 2}
                    value={String(val)}
                    onChange={(e) =>
                      setVoice({
                        ...voice,
                        config: { ...voice.config, [key]: e.target.value },
                      })
                    }
                  />
                </Field>
              ))}
          </div>
          <button
            className="primary"
            onClick={() =>
              void api("/voice", "POST", {
                config: voice.config,
                expectedVersion: voice.version,
              })
                .then(() => api("/voice"))
                .then(setVoice)
                .catch((e) => setError(e.message))
            }
          >
            {w("Approve voice profile", "Duyệt giọng văn")}
          </button>
        </section>
      )}
    </>
  );
}
