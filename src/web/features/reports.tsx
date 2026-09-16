import React, { useState, useEffect } from "react";
import { api, Field, Failure, useWords } from "./publisher.js";
import type { Actor } from "../../server/auth/index.js";
const number = (n: any) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
function Trend({
  rows,
  value,
  label,
}: {
  rows: any[];
  value: string;
  label: string;
}) {
  if (!rows.length)
    return <p className="empty-state">No observations / Chưa có dữ liệu</p>;
  const max = Math.max(1, ...rows.map((r) => Number(r[value])));
  const x = (i: number) =>
    rows.length === 1 ? 300 : 30 + (i * 540) / (rows.length - 1);
  return (
    <figure className="trend">
      <figcaption>{label}</figcaption>
      <svg viewBox="0 0 600 170" role="img" aria-label={label}>
        <line x1="30" y1="140" x2="570" y2="140" stroke="#cad7ca" />
        <polyline
          fill="none"
          stroke="#225640"
          strokeWidth="3"
          points={rows
            .map((r, i) => `${x(i)},${140 - (Number(r[value]) / max) * 105}`)
            .join(" ")}
        />
        {rows.map((r, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={140 - (Number(r[value]) / max) * 105}
            r="4"
            fill="#225640"
          >
            <title>
              {String(r.day).slice(0, 10)}: {number(r[value])}
            </title>
          </circle>
        ))}
        <text x="30" y="162" fontSize="11">
          {String(rows[0].day).slice(0, 10)}
        </text>
        <text x="570" y="162" textAnchor="end" fontSize="11">
          {String(rows.at(-1).day).slice(0, 10)}
        </text>
        <text x="30" y="20" fontSize="11">
          {number(max)}
        </text>
      </svg>
    </figure>
  );
}
export function Reports({ channels }: { channels: any[] }) {
  const w = useWords();
  const [days, setDays] = useState(28);
  const [channel, setChannel] = useState("");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState("");
  const [prefs, setPrefs] = useState({
    digest_email: false,
    digest_sms: false,
  });
  useEffect(() => {
    void api("/reports?days=" + days + (channel ? "&channelId=" + channel : ""))
      .then(setData)
      .catch((e) => setError(e.message));
  }, [days, channel]);
  useEffect(() => {
    void api("/digest/preferences")
      .then(setPrefs)
      .catch((e) => setError(e.message));
  }, []);
  const keys = [
    ...new Set<string>(
      (data?.snapshots ?? []).map((r: any) =>
        [r.channel_id, r.object_id, r.metric].join("|"),
      ),
    ),
  ];
  const selected = metric && keys.includes(metric) ? metric : keys[0];
  const points = (data?.snapshots ?? []).filter(
    (r: any) => [r.channel_id, r.object_id, r.metric].join("|") === selected,
  );
  const field = points[0];
  const current = points.filter(
    (r: any) =>
      String(r.day).slice(0, 10) >=
      new Date(Date.parse(data.bounds.start) + 7 * 3600000)
        .toISOString()
        .slice(0, 10),
  );
  const prev = points.filter((r: any) => !current.includes(r));
  const total = (rows: any[]) =>
    !rows.length
      ? null
      : field.kind === "daily" && !field.metric.includes("unique")
        ? rows.reduce((n, r) => n + Number(r.value), 0)
        : Number(rows.at(-1).value);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            {w("SOCIAL INTELLIGENCE", "THÔNG TIN VẬN HÀNH")}
          </span>
          <h1>{w("Audience & operations", "Khán giả & vận hành")}</h1>
          <p>
            {w(
              "Source evidence, measured replies, and a matched previous period.",
              "Dữ liệu nguồn, phản hồi đã gửi và kỳ trước cùng độ dài.",
            )}
          </p>
        </div>
      </div>
      <Failure error={error} />
      <div className="button-row">
        {[1, 7, 28, 90].map((d) => (
          <button
            key={d}
            className={days === d ? "primary" : "secondary"}
            onClick={() => setDays(d)}
          >
            {d === 1 ? w("Today", "Hôm nay") : d + w(" days", " ngày")}
          </button>
        ))}
        <select
          aria-label={w("Report channel", "Kênh báo cáo")}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="">
            {w("All allowed channels", "Tất cả kênh được phép")}
          </option>
          {channels.map((c) => (
            <option value={c.id} key={c.id}>
              {c.display_name}
            </option>
          ))}
        </select>
      </div>
      {data && (
        <>
          <p className="muted">
            {new Date(data.bounds.start).toLocaleString(undefined, {
              timeZone: "Asia/Ho_Chi_Minh",
            })}{" "}
            →{" "}
            {new Date(data.bounds.end).toLocaleString(undefined, {
              timeZone: "Asia/Ho_Chi_Minh",
            })}{" "}
            · Asia/Ho_Chi_Minh
          </p>
          <div className="report-kpis">
            {[
              ["inquiries", w("Inquiries", "Câu hỏi")],
              ["replies_sent", w("Confirmed replies", "Phản hồi đã gửi")],
              ["escalations", w("Escalations", "Chuyển người")],
              ["unanswered", w("Awaiting reply", "Chờ trả lời")],
              [
                "first_response_seconds",
                w("First response · seconds", "Phản hồi đầu · giây"),
              ],
              [
                "resolution_seconds",
                w("Resolution · seconds", "Giải quyết · giây"),
              ],
            ].map(([key, label]) => (
              <article className="panel section" key={key}>
                <small>{label}</small>
                <strong className="kpi-number">
                  {number(data.current[key])}
                </strong>
                <small>
                  {w("Previous", "Kỳ trước")}: {number(data.previous[key])} · Δ{" "}
                  {data.current[key] !== null && data.previous[key] !== null
                    ? number(data.current[key] - data.previous[key])
                    : "—"}
                </small>
              </article>
            ))}
          </div>
          <p className="muted">
            {w("Simulated replies", "Phản hồi mô phỏng")}:{" "}
            {data.current.simulated_replies} ·{" "}
            {w("Manual inquiries", "Câu hỏi thủ công")}:{" "}
            {data.current.manual_inquiries} ·{" "}
            {w("Automation rate", "Tỷ lệ tự động")}:{" "}
            {data.current.automation_rate === null
              ? "—"
              : number(data.current.automation_rate * 100) + "%"}{" "}
            · {w("Response sample", "Mẫu phản hồi")}:{" "}
            {data.current.response_sample_size}
          </p>
          {data.snapshotsTruncated && (
            <p className="notice">
              {w(
                "Showing the latest 15,000 observations. Narrow the channel or period for complete comparison.",
                "Hiển thị 15.000 quan sát mới nhất. Chọn kênh hoặc khoảng thời gian ngắn hơn để so sánh đầy đủ.",
              )}
            </p>
          )}
          <div className="workspace-columns equal">
            <section className="panel section">
              <Trend
                rows={data.current.daily}
                value="inquiries"
                label={w("Inquiry volume", "Lượng câu hỏi")}
              />
              <h3>{w("Most asked products", "Sản phẩm được hỏi nhiều")}</h3>
              <p className="muted">
                {w(
                  "Matched source SKUs; ambiguous mentions are excluded.",
                  "SKU khớp nguồn; không tính đề cập chưa rõ sản phẩm.",
                )}
              </p>
              {data.current.askedProducts.map((p: any) => (
                <p key={p.sku}>
                  {p.sku}: {p.inquiries}
                </p>
              ))}
              <h3>{w("Intent mix", "Phân bố ý định")}</h3>
              {data.current.intentMix.map((i: any) => (
                <p key={i.intent}>
                  {i.intent}: <strong>{i.count}</strong>
                </p>
              ))}
            </section>
            <section className="panel section">
              <Trend
                rows={data.current.daily}
                value="sent"
                label={w("Confirmed replies", "Phản hồi đã gửi")}
              />
              <h3>{w("Escalation reasons", "Lý do chuyển người")}</h3>
              {data.current.reasons.map((r: any) => (
                <p key={r.reason}>
                  {r.reason.replaceAll("_", " ")}: <strong>{r.count}</strong>
                </p>
              ))}
            </section>
          </div>
          <section className="panel section">
            <h2>{w("Platform observations", "Quan sát từ nền tảng")}</h2>
            {!data.enabled && (
              <p className="notice warning">
                {w(
                  "Audience collection is disabled. Enable it in server configuration and reconnect for metrics scopes.",
                  "Thu thập số liệu chưa bật. Bật trong cấu hình máy chủ rồi kết nối lại để cấp quyền số liệu.",
                )}
              </p>
            )}
            <p>
              {w(
                "Daily unique viewers cannot be added across days. Cumulative counters and follower totals are observations, not daily gains.",
                "Không cộng người xem duy nhất của các ngày. Bộ đếm tích lũy và tổng người theo dõi là số quan sát, không phải tăng trưởng từng ngày.",
              )}
            </p>
            {keys.length ? (
              <>
                <Field label={w("Metric / object", "Chỉ số / đối tượng")}>
                  <select
                    value={selected}
                    onChange={(e) => setMetric(e.target.value)}
                  >
                    {keys.map((k) => {
                      const r = data.snapshots.find(
                        (x: any) =>
                          [x.channel_id, x.object_id, x.metric].join("|") === k,
                      );
                      return (
                        <option value={k} key={k}>
                          {r.display_name} · {r.object_id} · {r.metric}
                        </option>
                      );
                    })}
                  </select>
                </Field>
                <p>
                  {field?.kind === "daily" && !field?.metric.includes("unique")
                    ? w(
                        "Sum of available daily observations",
                        "Tổng số quan sát hằng ngày hiện có",
                      )
                    : w(
                        "Latest observation in each period",
                        "Quan sát cuối cùng của mỗi kỳ",
                      )}
                  : <strong>{number(total(current))}</strong> ·{" "}
                  {w("Previous", "Kỳ trước")}: {number(total(prev))} ·{" "}
                  {field.source} · {field.period}
                </p>
                <Trend rows={points} value="value" label={field.metric} />
                <details>
                  <summary>
                    {w("Immutable source snapshots", "Bản ghi nguồn bất biến")}{" "}
                    ({points.length})
                  </summary>
                  {points.map((p: any) => (
                    <p key={p.id}>
                      {String(p.day).slice(0, 10)} · {number(p.value)} ·{" "}
                      {p.source} · {p.period} ·{" "}
                      {p.source_end_time ?? p.fetched_at}
                    </p>
                  ))}
                </details>
              </>
            ) : (
              <p className="empty-state">
                {w(
                  "No platform snapshots yet. No history has been invented.",
                  "Chưa có bản ghi nền tảng. Không tạo lịch sử giả.",
                )}
              </p>
            )}
            {data.collections.map((r: any) => (
              <p key={r.id}>
                {r.display_name}: {r.status} · {r.reason ?? r.rows + " rows"} ·{" "}
                {new Date(r.created_at).toLocaleString()}
              </p>
            ))}
          </section>
          <div className="workspace-columns equal">
            <section className="panel section">
              <h2>{w("Customers & approvals", "Khách hàng & phê duyệt")}</h2>
              <p>
                {w("New", "Mới")}: {data.current.customers.new} ·{" "}
                {w("Returning", "Quay lại")}: {data.current.customers.returning}
              </p>
              {data.current.approvals.map((a: any) => (
                <p key={a.actor_id}>
                  {a.actor_id}: {a.count} · {number(a.seconds)}s
                </p>
              ))}
              <details>
                <summary>
                  {w(
                    "Hour-of-week volume (Vietnam time)",
                    "Lượng tin theo giờ trong tuần (giờ Việt Nam)",
                  )}
                </summary>
                {data.current.hours.map((h: any) => (
                  <p key={h.weekday + ":" + h.hour}>
                    {h.weekday} · {h.hour}:00 · {h.count}
                  </p>
                ))}
              </details>
            </section>
            <section className="panel section">
              <h2>
                {w(
                  "Confirmed order attribution",
                  "Liên kết đơn hàng đã xác nhận",
                )}
              </h2>
              <p>
                {w(
                  "Orders linked by staff in this period",
                  "Đơn do nhân viên liên kết trong kỳ",
                )}
                : {data.conversion.linkedOrders}
              </p>
              <p>
                {w(
                  "Inquiry conversations linked to orders",
                  "Cuộc hội thoại có liên kết đơn",
                )}
                :{" "}
                {data.conversion.rate === null
                  ? "—"
                  : number(data.conversion.rate * 100) + "%"}{" "}
                ({data.conversion.convertedConversations} /{" "}
                {data.conversion.inquiryConversations})
              </p>
              <p className="muted">
                {w(
                  "Conversations with incoming messages in this period and a staff-confirmed order link by period end. Each conversation counts once.",
                  "Hội thoại có tin đến trong kỳ và đơn được nhân viên xác nhận trước cuối kỳ. Mỗi hội thoại chỉ tính một lần.",
                )}
              </p>
              {Object.entries(data.conversion.revenue).map(
                ([currency, value]) => (
                  <p key={currency}>
                    {number(value)} {currency}
                  </p>
                ),
              )}
              {Object.entries(data.conversion.products).map(([sku, value]) => (
                <p key={sku}>
                  {sku}: {number(value)}
                </p>
              ))}
              <p className="muted">
                {w(
                  "Based on the immutable order version selected by staff. Product revenue requires explicit order lines; no sales are inferred from a message.",
                  "Dựa trên phiên bản đơn hàng nhân viên đã chọn. Doanh thu sản phẩm cần dòng đơn cụ thể; không suy đoán giao dịch từ tin nhắn.",
                )}
              </p>
            </section>
          </div>
        </>
      )}
      <section className="panel section">
        <h2>{w("Weekly digest", "Tổng kết hằng tuần")}</h2>
        <p>
          {w(
            "Monday at 08:00 Vietnam time. The largest changes and available evidence-linked insights.",
            "Thứ Hai 08:00 giờ Việt Nam. Biến động lớn và gợi ý kèm dữ liệu hiện có.",
          )}
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.digest_email}
            onChange={(e) =>
              setPrefs({ ...prefs, digest_email: e.target.checked })
            }
          />
          Email
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prefs.digest_sms}
            onChange={(e) =>
              setPrefs({ ...prefs, digest_sms: e.target.checked })
            }
          />
          SMS
        </label>
        <button
          onClick={() =>
            void api("/digest/preferences", "POST", {
              email: prefs.digest_email,
              sms: prefs.digest_sms,
            }).catch((e) => setError(e.message))
          }
        >
          {w("Save digest preferences", "Lưu tùy chọn tổng kết")}
        </button>
      </section>
    </>
  );
}
export function Analyst({
  actor,
  navigate,
}: {
  actor: Actor;
  navigate: (p: string) => void;
}) {
  const w = useWords();
  const [insights, setInsights] = useState<any[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("faq");
  const [busy, setBusy] = useState(false);
  const manage = ["owner", "manager"].includes(actor.role);
  const all = manage && actor.channelScope.includes("*");
  async function load() {
    setInsights((await api("/insights")).insights);
    if (all) setProposals((await api("/proposals")).proposals);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{w("Evidence & advice", "Dữ liệu & gợi ý")}</h1>
          <p>
            {w(
              "Review the evidence before changing how Helpa works.",
              "Xem dữ liệu trước khi thay đổi cách Helpa hoạt động.",
            )}
          </p>
        </div>
        {manage && (
          <button
            className="primary"
            onClick={() =>
              void api("/insights/refresh", "POST", {})
                .then(load)
                .catch((e) => setError(e.message))
            }
          >
            {w("Refresh insights", "Cập nhật gợi ý")}
          </button>
        )}
      </div>
      <Failure error={error} />
      {!insights.length && (
        <section className="panel section empty-state">
          {w(
            "No supported recommendations yet. Collect inquiry and platform history first; posting advice needs at least 10 posts and 3 in a time window.",
            "Chưa đủ dữ liệu để gợi ý. Thu thập lịch sử tin nhắn và nền tảng; gợi ý giờ đăng cần ít nhất 10 bài và 3 bài trong một khung giờ.",
          )}
        </section>
      )}
      <div className="report-insights">
        {insights
          .filter((i) => i.status === "open")
          .map((i) => (
            <article className="panel section" key={i.id}>
              <small>
                {i.display_name} · {i.detector} ·{" "}
                {new Date(i.period_end).toLocaleDateString()}
              </small>
              <h2>{w(i.recommendation.title, i.recommendation.titleVi)}</h2>
              <p>{i.recommendation.details}</p>
              <details>
                <summary>{w("Exact evidence", "Dữ liệu cụ thể")}</summary>
                <pre className="payload">
                  {JSON.stringify(i.evidence, null, 2)}
                </pre>
                <small>{i.id}</small>
              </details>
              <div className="button-row">
                <button
                  onClick={() => {
                    sessionStorage.setItem("helpa-insight", JSON.stringify(i));
                    navigate(i.recommendation.action);
                  }}
                >
                  {w("Review suggested action", "Xem hành động gợi ý")}
                </button>
                {manage && (
                  <button
                    onClick={() =>
                      void api("/insights/" + i.id + "/dismiss", "POST", {})
                        .then(load)
                        .catch((e) => setError(e.message))
                    }
                  >
                    {w("Dismiss", "Bỏ qua")}
                  </button>
                )}
              </div>
            </article>
          ))}
      </div>
      {all && (
        <section className="panel section">
          <h2>{w("Reviewable proposals", "Đề xuất cần duyệt")}</h2>
          <p>
            {w(
              "Uses your configured model and budget. FAQ/rule proposals use human edit pairs. Narratives use stored insights. Every change requires review.",
              "Dùng mô hình và ngân sách đã cấu hình. Đề xuất FAQ/quy tắc dựa trên bản sửa của người; tổng kết dựa trên gợi ý đã lưu. Mọi thay đổi cần duyệt.",
            )}
          </p>
          <div className="button-row">
            <select
              aria-label={w("Proposal type", "Loại đề xuất")}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="faq">FAQ</option>
              <option value="rules">Rules / Quy tắc</option>
              <option value="narrative">Narrative / Tổng kết</option>
            </select>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api("/proposals/generate", "POST", { kind })
                  .then(load)
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {busy
                ? w("Generating…", "Đang tạo…")
                : w("Generate proposal", "Tạo đề xuất")}
            </button>
          </div>
          {proposals.map((p) => (
            <article className="member-card" key={p.id}>
              <h3>
                {p.kind} · {p.status}
              </h3>
              <details>
                <summary>{w("Source evidence", "Dữ liệu nguồn")}</summary>
                <pre className="payload">
                  {JSON.stringify(p.evidence, null, 2)}
                </pre>
              </details>
              {p.status === "pending" ? (
                <>
                  <Field
                    label={w(
                      "Review and edit proposed content (JSON)",
                      "Xem và sửa nội dung đề xuất (JSON)",
                    )}
                  >
                    <textarea
                      rows={10}
                      value={edited[p.id] ?? JSON.stringify(p.content, null, 2)}
                      onChange={(e) =>
                        setEdited({ ...edited, [p.id]: e.target.value })
                      }
                    />
                  </Field>
                  <div className="button-row">
                    <button
                      className="primary"
                      onClick={() => {
                        try {
                          const content = JSON.parse(
                            edited[p.id] ?? JSON.stringify(p.content),
                          );
                          void api("/proposals/" + p.id + "/review", "POST", {
                            decision: "apply",
                            content,
                          })
                            .then(load)
                            .catch((e) => setError(e.message));
                        } catch {
                          setError(w("Invalid JSON", "JSON không hợp lệ"));
                        }
                      }}
                    >
                      {w(
                        "Approve & apply this revision",
                        "Duyệt & áp dụng phiên bản này",
                      )}
                    </button>
                    <button
                      onClick={() =>
                        void api("/proposals/" + p.id + "/review", "POST", {
                          decision: "reject",
                        })
                          .then(load)
                          .catch((e) => setError(e.message))
                      }
                    >
                      {w("Reject", "Từ chối")}
                    </button>
                  </div>
                </>
              ) : (
                <pre className="payload">
                  {JSON.stringify(p.content, null, 2)}
                </pre>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
