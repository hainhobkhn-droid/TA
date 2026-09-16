import { can } from "../../shared/permissions.js";
import React, { useState, useEffect } from "react";
import type { Actor } from "../../server/auth/index.js";
import { api, Field, Failure, useWords } from "./publisher.js";
export function Inbox({ actor, channels }: { actor: Actor; channels: any[] }) {
  const w = useWords();
  const write = can(
    actor.role,
    actor.channelScope,
    "replies.write",
    undefined,
    actor.deniedPermissions,
  );
  const approve = can(
    actor.role,
    actor.channelScope,
    "approvals.write",
    undefined,
    actor.deniedPermissions,
  );
  const [notifications, setNotifications] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [newThread, setNewThread] = useState(false);
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [customer, setCustomer] = useState("");
  const [text, setText] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [orderId, setOrderId] = useState("");
  const [linked, setLinked] = useState(false);
  const [followup, setFollowup] = useState("");
  async function load() {
    try {
      setItems((await api("/inbox?filter=" + filter)).conversations);
      setNotifications((await api("/notifications")).notifications);
      if (selected) setDetail(await api("/inbox/" + selected));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [selected, filter]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api("/inbox/manual", "POST", {
        channelId,
        customerId: customer,
        text,
      });
      setNewThread(false);
      setSelected(r.conversationId);
      setText("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const minutes = (value: string) =>
    Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{w("THE FRONT DESK", "HỘP THƯ")}</span>
          <h1>{w("Customer inbox", "Hộp thư khách hàng")}</h1>
          <p>
            {w(
              "Review the message, intent, and exact facts behind each reply.",
              "Xem tin nhắn, ý định và dữ liệu chính xác cho mỗi phản hồi.",
            )}
          </p>
        </div>
        {write && (
          <button className="primary" onClick={() => setNewThread(true)}>
            {w("Paste a manual inquiry", "Dán câu hỏi thủ công")}
          </button>
        )}
      </div>
      <Failure error={error} />
      {notifications.length > 0 && (
        <details className="panel section">
          <summary>
            {w("Your notifications", "Thông báo của bạn")} ·{" "}
            {notifications.length}
          </summary>
          {notifications.map((n) => (
            <article className="operation" key={n.id}>
              <strong>{n.subject}</strong>
              <p>{n.body}</p>
              <small>{new Date(n.created_at).toLocaleString()}</small>
            </article>
          ))}
        </details>
      )}
      <div className="button-row inbox-filters">
        {[
          ["all", "All", "Tất cả"],
          ["mine", "Mine", "Của tôi"],
          ["needs_approval", "Needs approval", "Cần duyệt"],
          ["escalated", "Escalated", "Chuyển người xử lý"],
        ].map(([id, en, vi]) => (
          <button
            className={filter === id ? "active" : ""}
            key={id}
            onClick={() => setFilter(id)}
          >
            {w(en, vi)}
          </button>
        ))}
      </div>
      <div className="inbox-layout">
        <aside className="panel inbox-list">
          {items.map((v) => (
            <button
              className={"thread-button " + (selected === v.id ? "active" : "")}
              key={v.id}
              onClick={() => {
                setSelected(v.id);
                setDetail(null);
              }}
            >
              <div>
                <strong>{v.customer_id}</strong>
                <span>
                  {v.platform} · {v.kind}
                </span>
              </div>
              <p>{v.latest_text}</p>
              <small>
                {v.draft_status ?? w("Processing", "Đang xử lý")}{" "}
                {v.draft_status === "needs_approval" &&
                  ` · ${minutes(v.waiting_since)} min`}
              </small>
            </button>
          ))}
          {!items.length && (
            <p className="empty-state">
              {w(
                "No inquiries in this view",
                "Chưa có câu hỏi trong bộ lọc này",
              )}
            </p>
          )}
        </aside>
        <section className="panel section conversation-panel">
          {detail ? (
            <>
              <div className="panel-heading">
                <div>
                  <h2>{detail.conversation.customer_id}</h2>
                  <span className="pill">
                    {detail.conversation.kind === "manual"
                      ? w(
                          "Manual thread — copy approved replies",
                          "Luồng thủ công — sao chép phản hồi đã duyệt",
                        )
                      : detail.conversation.mode}
                  </span>
                </div>
                {write && (
                  <div className="button-row">
                    <button
                      onClick={() =>
                        void api("/inbox/" + selected, "PATCH", {
                          assignToMe: true,
                        })
                          .then(load)
                          .catch((e) => setError(e.message))
                      }
                    >
                      {w("Assign to me", "Giao cho tôi")}
                    </button>
                    <button
                      onClick={() =>
                        void api("/inbox/" + selected, "PATCH", {
                          status:
                            detail.conversation.status === "resolved"
                              ? "open"
                              : "resolved",
                        })
                          .then(load)
                          .catch((e) => setError(e.message))
                      }
                    >
                      {detail.conversation.status === "resolved"
                        ? w("Reopen", "Mở lại")
                        : w("Resolve", "Hoàn tất")}
                    </button>
                  </div>
                )}
              </div>
              {write && (
                <form
                  className="order-link"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void api("/inbox/" + selected + "/order", "POST", {
                      orderId,
                    })
                      .then(() => {
                        setLinked(true);
                        setOrderId("");
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  <Field
                    label={w(
                      "Confirm an order belongs to this inquiry",
                      "Xác nhận đơn hàng thuộc câu hỏi này",
                    )}
                  >
                    <input
                      required
                      value={orderId}
                      onChange={(e) => {
                        setOrderId(e.target.value);
                        setLinked(false);
                      }}
                      placeholder={w("Exact order ID", "Mã đơn chính xác")}
                    />
                  </Field>
                  <button>
                    {w("Link confirmed order", "Liên kết đơn đã xác nhận")}
                  </button>
                  {linked && (
                    <small>
                      {w(
                        "Order linked to its source version.",
                        "Đã liên kết phiên bản nguồn của đơn.",
                      )}
                    </small>
                  )}
                </form>
              )}
              {detail.messages.map((m: any) => (
                <article
                  key={m.id}
                  className={
                    "message-bubble " + (m.from_business ? "outgoing" : "")
                  }
                >
                  <small>
                    {m.from_business ? "Helpa" : w("Customer", "Khách hàng")} ·{" "}
                    {new Date(m.sent_at).toLocaleString(actor.locale, {
                      timeZone: actor.timezone,
                    })}
                  </small>
                  <p>{m.text}</p>
                  {m.attachments.length > 0 && (
                    <p>
                      {w(
                        "Attachment requires human review",
                        "Tệp đính kèm cần người xem xét",
                      )}
                    </p>
                  )}
                </article>
              ))}
              {detail.drafts.map((d: any) => (
                <article className="draft-card" key={d.id}>
                  <div className="post-card-top">
                    <strong>{w("Reply draft", "Bản nháp trả lời")}</strong>
                    <span className="pill">
                      {d.status} · r{d.revision}
                    </span>
                  </div>
                  <p className="intent-tags">
                    {d.analysis.intents.join(" · ")} · {d.analysis.language} ·{" "}
                    {Math.round(d.analysis.confidence * 100)}% ·{" "}
                    {d.analysis.provider}
                  </p>
                  {d.checks.reasons.length > 0 && (
                    <div className="notice warning">
                      {d.checks.reasons
                        .map((r: string) => r.replaceAll("_", " "))
                        .join(" · ")}
                    </div>
                  )}
                  {approve &&
                  ["needs_approval", "queued"].includes(d.status) ? (
                    <>
                      <Field
                        label={w(
                          "Reply text to approve",
                          "Nội dung phản hồi cần duyệt",
                        )}
                      >
                        <textarea
                          rows={5}
                          value={edits[d.id] ?? d.text}
                          onChange={(e) =>
                            setEdits({ ...edits, [d.id]: e.target.value })
                          }
                        />
                      </Field>
                      <button
                        className="primary"
                        onClick={() =>
                          void api("/replies/" + d.id + "/approve", "POST", {
                            revision: d.revision,
                            text: edits[d.id] ?? d.text,
                          })
                            .then(load)
                            .catch((e) => setError(e.message))
                        }
                      >
                        {w("Approve this reply", "Duyệt phản hồi này")}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="reply-text">{d.text}</p>
                      {[
                        "approved",
                        "manual_ready",
                        "would_have_sent",
                        "sent",
                      ].includes(d.status) && (
                        <button
                          onClick={() =>
                            void navigator.clipboard.writeText(d.text)
                          }
                        >
                          {w(
                            "Copy approved reply",
                            "Sao chép phản hồi đã duyệt",
                          )}
                        </button>
                      )}
                    </>
                  )}
                  <details>
                    <summary>
                      {w(
                        "Facts & source versions",
                        "Dữ liệu & phiên bản nguồn",
                      )}{" "}
                      ({d.facts.length})
                    </summary>
                    <p className="muted">
                      {w(
                        "Last-known facts can appear here even when rejected from customer text. Check timestamps and reasons.",
                        "Dữ liệu gần nhất có thể hiển thị ở đây dù bị loại khỏi phản hồi. Kiểm tra thời gian và lý do.",
                      )}
                    </p>
                    {d.facts.map((f: any, i: number) => (
                      <div className="fact-row" key={i}>
                        <strong>
                          {f.recordKey} · {f.field}
                        </strong>
                        <code>{JSON.stringify(f.value)}</code>
                        <small>
                          v{f.recordVersion} · {w("row", "dòng")} {f.sourceRow}{" "}
                          · {f.asOf} · {w("max age", "thời hạn")}{" "}
                          {f.maxAgeHours}h
                        </small>
                      </div>
                    ))}
                  </details>
                </article>
              ))}
              {write && detail.conversation.kind === "manual" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void api("/inbox/" + selected + "/messages", "POST", {
                      text: followup,
                    })
                      .then(() => {
                        setFollowup("");
                        return load();
                      })
                      .catch((e) => setError(e.message));
                  }}
                >
                  <Field
                    label={w(
                      "Next customer message",
                      "Tin nhắn tiếp theo của khách",
                    )}
                  >
                    <textarea
                      required
                      rows={3}
                      value={followup}
                      onChange={(e) => setFollowup(e.target.value)}
                    />
                  </Field>
                  <button>
                    {w("Run inquiry pipeline", "Phân tích câu hỏi")}
                  </button>
                </form>
              )}
            </>
          ) : (
            <div className="empty-state">
              {w("Select a conversation", "Chọn cuộc trò chuyện")}
            </div>
          )}
        </section>
      </div>
      {newThread && (
        <div className="modal-backdrop">
          <section
            className="editor-panel"
            role="dialog"
            aria-modal="true"
            aria-label={w("Manual inquiry", "Câu hỏi thủ công")}
          >
            <form onSubmit={create}>
              <div className="panel-heading">
                <h2>{w("Manual inquiry", "Câu hỏi thủ công")}</h2>
                <button type="button" onClick={() => setNewThread(false)}>
                  {w("Close", "Đóng")}
                </button>
              </div>
              <Field label={w("Channel", "Kênh")}>
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name} · {c.platform}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={w("Customer reference", "Mã nhận diện khách")}>
                <input
                  required
                  value={customer}
                  onChange={(e) => setCustomer(e.target.value)}
                />
              </Field>
              <Field label={w("Customer message", "Tin nhắn khách")}>
                <textarea
                  required
                  rows={6}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              <button className="primary">
                {w("Create & analyze", "Tạo & phân tích")}
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
