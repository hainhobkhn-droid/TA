import { can } from "../../shared/permissions.js";
import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  CalendarDays,
  Plus,
  Image,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Upload,
} from "lucide-react";
import {
  businessInstant,
  businessLocal,
  type VariantInput,
} from "../../shared/publishing.js";
import type { Actor } from "../../server/auth/index.js";
export async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "REQUEST_FAILED");
  return d;
}
export function useWords() {
  const { i18n } = useTranslation();
  return (en: string, vi: string) => (i18n.language === "vi" ? vi : en);
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id,
      })}
    </div>
  );
}
export function Failure({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="notice error">
      {error.replaceAll("_", " ")}
    </div>
  ) : null;
}
export function Publisher({
  actor,
  channels,
}: {
  actor: Actor;
  channels: any[];
}) {
  const w = useWords();
  const [posts, setPosts] = useState<any[]>([]);
  const [media, setMedia] = useState<any[]>([]);
  const [view, setView] = useState("list");
  const [anchor, setAnchor] = useState(
    businessLocal(new Date().toISOString()).slice(0, 10),
  );
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [variants, setVariants] = useState<VariantInput[]>([]);
  const [repeat, setRepeat] = useState(false);
  const [weeks, setWeeks] = useState(4);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const write = can(
    actor.role,
    actor.channelScope,
    "posts.write",
    undefined,
    actor.deniedPermissions,
  );
  const approve =
    ["owner", "manager"].includes(actor.role) &&
    can(
      actor.role,
      actor.channelScope,
      "approvals.write",
      undefined,
      actor.deniedPermissions,
    );
  async function load() {
    try {
      const [p, m] = await Promise.all([api("/posts"), api("/media")]);
      setPosts(p.variants);
      setMedia(m.assets);
      setPaused(p.paused);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);
  const fresh = (ch = channels[0]): VariantInput => ({
    channelId: ch?.id ?? "",
    format: ch?.platform === "tiktok" ? "tiktok_video" : "text",
    caption: "",
    hashtags: [],
    firstComment: "",
    mediaIds: [],
    scheduledAt: null,
    ...(ch?.platform === "tiktok"
      ? {
          tiktok: {
            mode: "manual" as const,
            allowComment: false,
            allowDuet: false,
            allowStitch: false,
            ownBrand: true,
            paidPartnership: false,
            aiGenerated: false,
            consent: false,
            musicRights: false,
          },
        }
      : {}),
  });
  useEffect(() => {
    try {
      const suggestion = JSON.parse(
        sessionStorage.getItem("helpa-insight") ?? "null",
      );
      if (suggestion?.detector === "posting_hours" && write) {
        const ch = channels.find((c) => c.id === suggestion.channel_id);
        if (!ch) return;
        const tomorrow = new Date(Date.now() + 86400000 + 7 * 3600000)
          .toISOString()
          .slice(0, 10);
        const scheduledAt = businessInstant(
          tomorrow +
            "T" +
            String(suggestion.evidence.windowStart).padStart(2, "0") +
            ":00",
        );
        newPost({
          title: w("Test suggested posting window", "Thử khung giờ được gợi ý"),
          channel_id: ch.id,
          payload: { ...fresh(ch), scheduledAt },
          suggestedAt: scheduledAt,
        });
        sessionStorage.removeItem("helpa-insight");
      }
    } catch {}
  }, []);
  function newPost(p?: any, edit = false) {
    setError("");
    setEditing(edit ? p : { id: null });
    setTitle(p?.title ?? "");
    setVariants(
      p
        ? [
            {
              ...fresh(channels.find((c) => c.id === p.channel_id)),
              ...Object.fromEntries(
                Object.entries(p.payload).filter(([k]) =>
                  [
                    "channelId",
                    "format",
                    "caption",
                    "hashtags",
                    "firstComment",
                    "mediaIds",
                    "tiktok",
                  ].includes(k),
                ),
              ),
              scheduledAt: edit ? p.scheduled_at : (p.suggestedAt ?? null),
            },
          ]
        : [fresh()],
    );
    setRepeat(false);
  }
  function update(i: number, b: Partial<VariantInput>) {
    setVariants((v) => v.map((x, n) => (i === n ? { ...x, ...b } : x)));
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (editing?.id)
        await api("/posts/" + editing.id, "PATCH", {
          expectedRevision: editing.revision,
          variant: variants[0],
        });
      else if (repeat) {
        if (!variants[0].scheduledAt) throw new Error("SCHEDULE_REQUIRED");
        const local = businessLocal(variants[0].scheduledAt);
        await api("/recurring", "POST", {
          title,
          variants,
          weekday: new Date(local.slice(0, 10) + "T00:00Z").getUTCDay(),
          localTime: local.slice(11),
          weeks,
        });
      } else await api("/posts", "POST", { title, variants });
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function reschedule(id: string, date: string) {
    const p = posts.find((p) => p.id === id);
    if (!p) return;
    try {
      const { platform, pageId, businessTimezone, media, ...v } = p.payload;
      await api("/posts/" + id, "PATCH", {
        expectedRevision: p.revision,
        variant: {
          ...v,
          scheduledAt: businessInstant(
            date +
              "T" +
              (p.scheduled_at
                ? businessLocal(p.scheduled_at).slice(11)
                : "18:00"),
          ),
        },
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const fmt = (iso: string, tz = actor.timezone) =>
    new Intl.DateTimeFormat(actor.locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: tz,
    }).format(new Date(iso));
  const status = (s: string) =>
    ({
      draft: w("Draft", "Bản nháp"),
      scheduled: w("Scheduled", "Đã lên lịch"),
      publishing: w("Publishing", "Đang đăng"),
      published: w("Published", "Đã đăng"),
      would_have_sent: w("Would have sent", "Sẽ gửi (thử nghiệm)"),
      needs_action: w("Needs action", "Cần xử lý"),
      failed: w("Failed", "Lỗi"),
    })[s] ?? s;
  const card = (p: any) => (
    <article
      key={p.id}
      className="post-card"
      draggable={write && ["draft", "scheduled"].includes(p.status)}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", p.id)}
    >
      <div className="post-card-top">
        <span className="eyebrow">
          {p.platform} · {p.payload.format}
        </span>
        <span
          className={"pill " + (p.status === "needs_action" ? "warning" : "")}
        >
          {status(p.status)}
        </span>
      </div>
      <h3>{p.title}</h3>
      <p className="post-caption">{p.payload.caption}</p>
      {p.payload.media?.[0] && (
        <img
          className="post-thumb"
          src={`/api/media/${p.payload.media[0].id}/thumbnail`}
          alt={p.title}
        />
      )}
      <small>
        {p.scheduled_at
          ? fmt(p.scheduled_at, "Asia/Ho_Chi_Minh") + " · VN"
          : w("No publish time", "Chưa chọn thời gian")}
      </small>
      {p.scheduled_at && actor.timezone !== "Asia/Ho_Chi_Minh" && (
        <small>
          {fmt(p.scheduled_at)} · {actor.timezone}
        </small>
      )}
      {p.posts_require_approval && p.approved_revision !== p.revision && (
        <p className="text-warning">
          {w("Approval required", "Cần phê duyệt")} · r{p.revision}
        </p>
      )}
      {p.error && (
        <p className="text-warning">{p.error.replaceAll("_", " ")}</p>
      )}
      <div className="button-row">
        <button onClick={() => setDetail(p)}>
          {w("Review", "Xem chi tiết")}
        </button>
        {write && (
          <button
            aria-label={w("Duplicate", "Nhân bản")}
            onClick={() => newPost(p)}
          >
            <Copy size={15} />
          </button>
        )}
        {write && ["draft", "scheduled", "failed"].includes(p.status) && (
          <button onClick={() => newPost(p, true)}>{w("Edit", "Sửa")}</button>
        )}
        {approve &&
          p.approved_revision !== p.revision &&
          ["draft", "scheduled"].includes(p.status) && (
            <button
              onClick={() =>
                void api("/posts/" + p.id + "/approve", "POST", {
                  revision: p.revision,
                })
                  .then(load)
                  .catch((e) => setError(e.message))
              }
            >
              <Check size={14} />
              {w("Approve", "Duyệt")}
            </button>
          )}
      </div>
    </article>
  );
  const day = new Date(anchor + "T00:00Z");
  const start =
    view === "month"
      ? new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))
      : new Date(+day - day.getUTCDay() * 86400000);
  if (view === "month") start.setUTCDate(1 - start.getUTCDay());
  const days = Array.from({ length: view === "month" ? 42 : 7 }, (_, i) =>
    new Date(+start + i * 86400000).toISOString().slice(0, 10),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{w("THE PUBLISHER", "LỊCH NỘI DUNG")}</span>
          <h1>{w("Calendar & posts", "Lịch & bài đăng")}</h1>
          <p>
            {w(
              "Plan in Vietnam time. Every edit requires a fresh approval.",
              "Lên lịch theo giờ Việt Nam. Mỗi lần sửa cần duyệt lại.",
            )}
          </p>
        </div>
        {write && (
          <button
            className="primary"
            disabled={!channels.length}
            onClick={() => newPost()}
          >
            <Plus size={17} />
            {w("New post", "Tạo bài")}
          </button>
        )}
      </div>
      <Failure error={error} />
      {actor.role === "owner" && (
        <button
          className={paused ? "primary" : "secondary"}
          onClick={() =>
            void api("/publishing/pause", "PATCH", { paused: !paused })
              .then(load)
              .catch((e) => setError(e.message))
          }
        >
          {paused
            ? w("Resume publishing", "Tiếp tục đăng bài")
            : w("Pause publishing", "Tạm dừng đăng bài")}
        </button>
      )}
      <div className="notice">
        TikTok ·{" "}
        {w(
          "Manual export until account capabilities and product eligibility are verified. Direct Post audit approval is separate from scope grants.",
          "Xuất thủ công cho đến khi xác minh quyền tài khoản và điều kiện sản phẩm. Duyệt Direct Post tách biệt với cấp quyền ứng dụng.",
        )}
      </div>
      <div className="publisher-toolbar">
        <div className="button-row">
          {["list", "week", "month"].map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              onClick={() => setView(v)}
            >
              {v === "list"
                ? w("List", "Danh sách")
                : v === "week"
                  ? w("Week", "Tuần")
                  : w("Month", "Tháng")}
            </button>
          ))}
        </div>
        {view !== "list" && (
          <input
            aria-label={w("Calendar date", "Ngày lịch")}
            type="date"
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
          />
        )}
      </div>
      {!posts.length && (
        <div className="empty-state">
          <CalendarDays />
          <h3>{w("Your calendar is ready", "Lịch của bạn đã sẵn sàng")}</h3>
          <p>
            {w(
              "Create a draft, add channel variants, then choose a publish time.",
              "Tạo bản nháp, tùy chỉnh theo kênh rồi chọn giờ đăng.",
            )}
          </p>
        </div>
      )}
      {view === "list" ? (
        <div className="post-grid">{posts.map(card)}</div>
      ) : (
        <div className="calendar-scroll">
          <div className="calendar-grid">
            {days.map((date) => (
              <div
                key={date}
                className="calendar-cell"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void reschedule(e.dataTransfer.getData("text/plain"), date);
                }}
              >
                <strong>{date.slice(5)}</strong>
                {posts
                  .filter(
                    (p) =>
                      p.scheduled_at &&
                      businessLocal(p.scheduled_at).startsWith(date),
                  )
                  .map(card)}
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop">
          <section
            className="editor-panel"
            role="dialog"
            aria-modal="true"
            aria-label={w("Post editor", "Soạn bài")}
          >
            <form onSubmit={save}>
              <div className="panel-heading">
                <h2>
                  {editing.id
                    ? w("Edit revision", "Sửa phiên bản")
                    : w("Create post", "Tạo bài")}
                </h2>
                <button type="button" onClick={() => setEditing(null)}>
                  {w("Close", "Đóng")}
                </button>
              </div>
              <Failure error={error} />
              <Field label={w("Internal title", "Tiêu đề nội bộ")}>
                <input
                  required
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
              {variants.map((v, i) => (
                <fieldset key={i} className="variant-editor">
                  <legend>
                    {w("Channel variant", "Nội dung theo kênh")} {i + 1}
                  </legend>
                  <div className="form-grid">
                    <Field label={w("Channel", "Kênh")}>
                      <select
                        disabled={!!editing.id}
                        value={v.channelId}
                        onChange={(e) => {
                          const ch = channels.find(
                            (c) => c.id === e.target.value,
                          );
                          update(i, { ...fresh(ch), caption: v.caption });
                        }}
                      >
                        {channels.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.display_name} · {c.platform}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={w("Format", "Định dạng")}>
                      <select
                        value={v.format}
                        onChange={(e) =>
                          update(i, { format: e.target.value as any })
                        }
                      >
                        {(channels.find((c) => c.id === v.channelId)
                          ?.platform === "tiktok"
                          ? ["tiktok_video"]
                          : ["text", "photo", "multi_photo", "video", "reel"]
                        ).map((f) => (
                          <option key={f}>{f}</option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field label={w("Caption", "Nội dung")}>
                    <textarea
                      rows={5}
                      value={v.caption}
                      onChange={(e) => update(i, { caption: e.target.value })}
                    />
                  </Field>
                  <Field
                    label={w(
                      "Hashtags (space separated)",
                      "Hashtag (cách bằng dấu cách)",
                    )}
                  >
                    <input
                      value={v.hashtags.join(" ")}
                      onChange={(e) =>
                        update(i, {
                          hashtags: e.target.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                  </Field>
                  {v.format !== "tiktok_video" && (
                    <Field label={w("First comment", "Bình luận đầu tiên")}>
                      <textarea
                        rows={2}
                        value={v.firstComment}
                        onChange={(e) =>
                          update(i, { firstComment: e.target.value })
                        }
                      />
                    </Field>
                  )}
                  <Field
                    label={w(
                      "Publish time · Asia/Ho_Chi_Minh",
                      "Giờ đăng · Asia/Ho_Chi_Minh",
                    )}
                  >
                    <input
                      type="datetime-local"
                      value={v.scheduledAt ? businessLocal(v.scheduledAt) : ""}
                      onChange={(e) => {
                        try {
                          update(i, {
                            scheduledAt: e.target.value
                              ? businessInstant(e.target.value)
                              : null,
                          });
                        } catch {
                          setError("INVALID_BUSINESS_TIME");
                        }
                      }}
                    />
                  </Field>
                  {v.scheduledAt && <small>{v.scheduledAt} · UTC</small>}
                  <div className="media-selector">
                    {media
                      .filter((m) =>
                        m.scope.includes(
                          channels.find((c) => c.id === v.channelId)?.platform,
                        ),
                      )
                      .map((m) => (
                        <label key={m.id}>
                          <input
                            type="checkbox"
                            checked={v.mediaIds.includes(m.id)}
                            onChange={(e) =>
                              update(i, {
                                mediaIds: e.target.checked
                                  ? [...v.mediaIds, m.id]
                                  : v.mediaIds.filter((id) => id !== m.id),
                              })
                            }
                          />
                          {m.name} · {m.status}
                        </label>
                      ))}
                  </div>
                  {v.tiktok && (
                    <TikTokOptions
                      channelId={v.channelId}
                      value={v.tiktok}
                      onChange={(t) => update(i, { tiktok: t })}
                    />
                  )}
                  <p className="muted">
                    {w(
                      "Upload files in Media first. Preview and rights are your responsibility; Helpa never rewrites your copy.",
                      "Tải tệp lên Thư viện trước. Kiểm tra nội dung và quyền sử dụng; Helpa giữ nguyên nội dung của bạn.",
                    )}
                  </p>
                  {v.format === "reel" && (
                    <div className="notice">
                      {w(
                        "Page Reels are public. Required: 9:16, at least 540×960, 3–90 seconds, 24–60 fps.",
                        "Reel trên Trang là công khai. Yêu cầu: 9:16, tối thiểu 540×960, 3–90 giây, 24–60 fps.",
                      )}
                    </div>
                  )}
                </fieldset>
              ))}
              {!editing.id && (
                <>
                  <button
                    type="button"
                    onClick={() => setVariants([...variants, fresh()])}
                  >
                    {w("Add channel variant", "Thêm nội dung theo kênh")}
                  </button>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={repeat}
                      onChange={(e) => setRepeat(e.target.checked)}
                    />
                    {w(
                      "Repeat weekly at the first variant’s Vietnam time",
                      "Lặp hàng tuần theo giờ Việt Nam của nội dung đầu tiên",
                    )}
                  </label>
                  {repeat && (
                    <Field
                      label={w(
                        "Occurrences (each needs approval)",
                        "Số lần (mỗi lần cần duyệt)",
                      )}
                    >
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={weeks}
                        onChange={(e) => setWeeks(+e.target.value)}
                      />
                    </Field>
                  )}
                </>
              )}
              <div className="button-row">
                <button className="primary" disabled={busy}>
                  {busy
                    ? w("Saving…", "Đang lưu…")
                    : w("Save revision", "Lưu phiên bản")}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {detail && (
        <div className="modal-backdrop">
          <section
            className="editor-panel"
            role="dialog"
            aria-modal="true"
            aria-label={w("Payload review", "Xem dữ liệu gửi")}
          >
            <div className="panel-heading">
              <h2>
                {detail.title} · r{detail.revision}
              </h2>
              <button onClick={() => setDetail(null)}>
                {w("Close", "Đóng")}
              </button>
            </div>
            <p>{status(detail.status)}</p>
            {detail.validation.map((x: string) => (
              <div className="notice warning" key={x}>
                {x.replaceAll("_", " ")}
              </div>
            ))}
            <pre className="payload">
              {JSON.stringify(detail.payload, null, 2)}
            </pre>
            {detail.permalink && (
              <a href={detail.permalink} target="_blank" rel="noreferrer">
                {w("Open published post", "Mở bài đã đăng")}
              </a>
            )}
            <div className="button-row">
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(
                    [
                      detail.payload.caption,
                      ...detail.payload.hashtags,
                      detail.payload.firstComment,
                    ]
                      .filter(Boolean)
                      .join("\n"),
                  )
                }
              >
                {w("Copy content", "Sao chép nội dung")}
              </button>
              {detail.payload.media.map((m: any) => (
                <a
                  className="button"
                  key={m.id}
                  href={"/api/media/" + m.id + "/file"}
                  download
                >
                  {m.name ?? w("Download media", "Tải tệp")}
                </a>
              ))}
            </div>
            {write && detail.status === "needs_action" && (
              <button
                onClick={() =>
                  void api("/posts/" + detail.id + "/resume", "POST", {
                    revision: detail.revision,
                  })
                    .then(() => {
                      setDetail(null);
                      return load();
                    })
                    .catch((e) => setError(e.message))
                }
              >
                {w(
                  "Resume confirmed steps / check processing",
                  "Tiếp tục bước đã xác nhận / kiểm tra xử lý",
                )}
              </button>
            )}
            {write && detail.status === "needs_action" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = new FormData(e.currentTarget).get("permalink");
                  void api("/posts/" + detail.id + "/manual-complete", "POST", {
                    revision: detail.revision,
                    permalink: value,
                  })
                    .then(() => {
                      setDetail(null);
                      return load();
                    })
                    .catch((e) => setError(e.message));
                }}
              >
                <Field
                  label={w(
                    "Confirmed published permalink",
                    "Liên kết bài đã đăng được xác nhận",
                  )}
                >
                  <input name="permalink" type="url" required />
                </Field>
                <button>
                  {w("Record manual completion", "Ghi nhận hoàn tất thủ công")}
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
export function MediaLibrary({ actor }: { actor: Actor }) {
  const w = useWords();
  const [assets, setAssets] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState(
    actor.channelScope.includes("*")
      ? "facebook,tiktok"
      : actor.channelScope.join(","),
  );
  const write = can(
    actor.role,
    actor.channelScope,
    "posts.write",
    undefined,
    actor.deniedPermissions,
  );
  async function load() {
    try {
      setAssets((await api("/media")).assets);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{w("MEDIA LIBRARY", "THƯ VIỆN")}</span>
          <h1>{w("Keep your originals", "Giữ nguyên bản gốc")}</h1>
          <p>
            {w(
              "Files stay on your VPS. Create a separate vertical rendition for Reels.",
              "Tệp được lưu trên VPS. Tạo bản dọc riêng cho Reel.",
            )}
          </p>
        </div>
      </div>
      <Failure error={error} />
      {write && (
        <div className="panel upload-panel">
          <Field label={w("Channel access", "Quyền truy cập theo kênh")}>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {[
                [
                  "facebook,tiktok",
                  w("Facebook + TikTok", "Facebook + TikTok"),
                ],
                ["facebook", "Facebook"],
                ["tiktok", "TikTok"],
              ]
                .filter(
                  ([s]) =>
                    actor.channelScope.includes("*") ||
                    s.split(",").every((x) => actor.channelScope.includes(x)),
                )
                .map(([s, n]) => (
                  <option key={s} value={s}>
                    {n}
                  </option>
                ))}
            </select>
          </Field>
          <Field
            label={
              busy
                ? w("Uploading…", "Đang tải…")
                : w(
                    "Upload image or video (100 MB default limit)",
                    "Tải ảnh hoặc video (giới hạn mặc định 100 MB)",
                  )
            }
          >
            <input
              disabled={busy}
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setBusy(true);
                setError("");
                void fetch(
                  "/api/media?" + new URLSearchParams({ name: f.name, scope }),
                  {
                    method: "POST",
                    headers: { "content-type": "application/octet-stream" },
                    body: f,
                  },
                )
                  .then(async (r) => {
                    const d = await r.json();
                    if (!r.ok) throw new Error(d.error);
                    await load();
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            />
          </Field>
        </div>
      )}
      <div className="media-grid">
        {assets.map((a) => (
          <article className="panel media-card" key={a.id}>
            {a.status === "ready" ? (
              <img src={"/api/media/" + a.id + "/thumbnail"} alt={a.name} />
            ) : (
              <div className="media-placeholder">
                <Image size={32} />
              </div>
            )}
            <h3>{a.name}</h3>
            <span className="pill">{a.status}</span>
            <p>
              {(Number(a.bytes) / 1048576).toFixed(1)} MB ·{" "}
              {a.scope.join(" / ")}
            </p>
            {a.metadata.width && (
              <small>
                {a.metadata.width}×{a.metadata.height} ·{" "}
                {a.metadata.duration?.toFixed(1)}s · {a.metadata.codec}
              </small>
            )}
            {a.error && <p role="alert">{a.error.replaceAll("_", " ")}</p>}
            <div className="button-row">
              <a href={"/api/media/" + a.id + "/file"} download>
                {w("Download", "Tải về")}
              </a>
              {write && a.status === "ready" && a.mime.startsWith("video/") && (
                <button
                  onClick={() =>
                    void api("/media/" + a.id + "/rendition", "POST", {})
                      .then(() =>
                        setError(
                          w(
                            "Rendition queued; the original stays unchanged.",
                            "Đã xếp hàng xử lý; bản gốc được giữ nguyên.",
                          ),
                        ),
                      )
                      .catch((e) => setError(e.message))
                  }
                >
                  {w("Create 9:16 Reel", "Tạo Reel 9:16")}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!assets.length && (
        <div className="empty-state">
          <Upload />
          <h3>
            {w("Add your first photo or video", "Thêm ảnh hoặc video đầu tiên")}
          </h3>
        </div>
      )}
    </>
  );
}
function TikTokOptions({
  value,
  channelId,
  onChange,
}: {
  value: NonNullable<VariantInput["tiktok"]>;
  channelId: string;
  onChange: (v: NonNullable<VariantInput["tiktok"]>) => void;
}) {
  const w = useWords();
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (value.mode === "direct")
      void api("/channels/" + channelId + "/creator")
        .then(setInfo)
        .catch((e) => setError(e.message));
  }, [channelId, value.mode]);
  return (
    <div className="tiktok-options">
      <Failure error={error} />
      <Field label={w("TikTok delivery mode", "Chế độ gửi TikTok")}>
        <select
          value={value.mode}
          onChange={(e) =>
            onChange({
              ...value,
              mode: e.target.value as any,
              privacy: undefined,
              consent: false,
            })
          }
        >
          <option value="manual">{w("Manual export", "Xuất thủ công")}</option>
          <option value="inbox">
            {w("Upload to TikTok inbox", "Tải vào hộp thư TikTok")}
          </option>
          <option value="direct">Direct Post</option>
        </select>
      </Field>
      {value.mode === "inbox" && (
        <p className="notice">
          {w(
            "Open the TikTok inbox notification to finish editing and publish in the TikTok app.",
            "Mở thông báo trong hộp thư TikTok để sửa và hoàn tất đăng bài trong ứng dụng.",
          )}
        </p>
      )}
      {value.mode === "direct" && (
        <>
          <p>
            {info?.creator?.creator_nickname} · @
            {info?.creator?.creator_username}
          </p>
          <p className="notice">
            {w("Eligibility", "Điều kiện")}: {info?.eligibility ?? "unverified"}
          </p>
          <Field
            label={w("Privacy (choose explicitly)", "Quyền riêng tư (tự chọn)")}
          >
            <select
              required
              value={value.privacy ?? ""}
              onChange={(e) =>
                onChange({ ...value, privacy: e.target.value as any })
              }
            >
              <option value="">
                {w("Choose privacy", "Chọn quyền riêng tư")}
              </option>
              {info?.creator?.privacy_level_options?.map((v: string) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          {(
            [
              [
                "allowComment",
                "Allow comments",
                "Cho phép bình luận",
                "comment_disabled",
              ],
              ["allowDuet", "Allow Duet", "Cho phép Duet", "duet_disabled"],
              [
                "allowStitch",
                "Allow Stitch",
                "Cho phép Stitch",
                "stitch_disabled",
              ],
            ] as const
          ).map(([key, en, vi, disabled]) => (
            <label className="check-row" key={key}>
              <input
                type="checkbox"
                disabled={!info || info.creator[disabled]}
                checked={value[key]}
                onChange={(e) =>
                  onChange({ ...value, [key]: e.target.checked })
                }
              />
              {w(en, vi)}
            </label>
          ))}
        </>
      )}
      {value.mode !== "manual" && (
        <>
          {(
            [
              [
                "ownBrand",
                "Promoting my own business",
                "Quảng bá doanh nghiệp của tôi",
              ],
              [
                "paidPartnership",
                "Paid partnership / branded content",
                "Hợp tác có trả phí / nội dung có thương hiệu",
              ],
              ["aiGenerated", "AI-generated content", "Nội dung do AI tạo"],
              [
                "musicRights",
                "I agree to TikTok’s Music Usage Confirmation",
                "Tôi đồng ý xác nhận sử dụng nhạc của TikTok",
              ],
              [
                "consent",
                "I reviewed this media and consent to send it to TikTok",
                "Tôi đã xem nội dung và đồng ý gửi đến TikTok",
              ],
            ] as const
          ).map(([key, en, vi]) => (
            <label className="check-row" key={key}>
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) =>
                  onChange({ ...value, [key]: e.target.checked })
                }
              />
              {w(en, vi)}
            </label>
          ))}
          <p>
            <a
              href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
              target="_blank"
              rel="noreferrer"
            >
              Music Usage Confirmation
            </a>{" "}
            ·{" "}
            <a
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noreferrer"
            >
              Branded Content Policy
            </a>
          </p>
          <p className="notice">
            {w(
              "Promotion of your business shows “Promotional content”; paid partnerships show “Paid partnership”. Public Direct Post requires verified product eligibility and an approved audit.",
              "Quảng bá doanh nghiệp hiển thị “Nội dung quảng cáo”; hợp tác trả phí hiển thị “Hợp tác có trả phí”. Direct Post công khai cần xác minh điều kiện và kiểm duyệt ứng dụng.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
export function ChannelControls({
  actor,
  channel,
  reload,
}: {
  actor: Actor;
  channel: any;
  reload: () => Promise<void>;
}) {
  const w = useWords();
  const [error, setError] = useState("");
  if (actor.role !== "owner") return null;
  return (
    <div className="channel-controls">
      <Failure error={error} />
      <Field label={w("Channel mode", "Chế độ kênh")}>
        <select
          value={channel.mode}
          onChange={(e) =>
            void api("/channels/" + channel.id + "/mode", "PATCH", {
              mode: e.target.value,
            })
              .then(reload)
              .catch((e) => setError(e.message))
          }
        >
          <option value="manual">{w("Manual", "Thủ công")}</option>
          <option value="dry_run">{w("Dry-run", "Thử nghiệm")}</option>
          <option value="live">{w("Live API", "API thực tế")}</option>
        </select>
      </Field>
      {channel.platform === "tiktok" && (
        <>
          <button
            onClick={() =>
              void api("/channels/tiktok/start", "POST", {})
                .then((r) => location.assign(r.url))
                .catch((e) => setError(e.message))
            }
          >
            {w("Connect / reconnect TikTok", "Kết nối / kết nối lại TikTok")}
          </button>
          <p>
            {w("Granted scopes", "Quyền đã cấp")}:{" "}
            {channel.granted_scopes.join(", ") || "—"}
            {channel.maintenance_error && (
              <p className="notice warning">
                {channel.maintenance_error.replaceAll("_", " ")}
              </p>
            )}
            {channel.token_checked_at && (
              <small>
                {w("Last token check", "Kiểm tra token gần nhất")}:{" "}
                {new Date(channel.token_checked_at).toLocaleString()}
              </small>
            )}
          </p>
          {channel.token_expires_at && (
            <p>
              {w("Token expires", "Token hết hạn")}:{" "}
              {new Date(channel.token_expires_at).toLocaleString()}
            </p>
          )}
          {channel.status === "connected" && (
            <button
              onClick={() =>
                void api("/channels/" + channel.id + "/disconnect", "POST", {})
                  .then(reload)
                  .catch((e) => setError(e.message))
              }
            >
              {w("Disconnect TikTok", "Ngắt TikTok")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
