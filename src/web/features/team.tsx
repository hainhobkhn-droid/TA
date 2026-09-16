import React, { useState, useEffect } from "react";
import { api, Field, Failure, useWords } from "./publisher.js";
import type { Actor } from "../../server/auth/index.js";
export function Passwordless({ onDone }: { onDone: () => Promise<void> }) {
  const w = useWords();
  const [method, setMethod] = useState("email");
  const [identity, setIdentity] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("magic") ?? "",
  );
  useEffect(() => {
    if (token)
      history.replaceState(null, "", location.pathname + location.search);
  }, []);
  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      if (token) {
        await api("/access/verify-email", "POST", { token });
        setToken("");
        await onDone();
      } else if (method === "phone" && sent) {
        await api("/access/verify-phone", "POST", { phone: identity, code });
        await onDone();
      } else {
        await api(
          "/access/" + method,
          "POST",
          method === "email" ? { email: identity } : { phone: identity },
        );
        setSent(true);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="passwordless">
      <h2>
        {w(
          "Invited or passwordless access",
          "Lời mời / đăng nhập không mật khẩu",
        )}
      </h2>
      <Failure error={error} />
      <form onSubmit={run}>
        {token ? (
          <p>
            {w(
              "Confirm to use your single-use sign-in link.",
              "Xác nhận để dùng liên kết đăng nhập một lần.",
            )}
          </p>
        ) : (
          <>
            <Field label={w("Sign-in method", "Cách đăng nhập")}>
              <select
                value={method}
                onChange={(e) => {
                  setMethod(e.target.value);
                  setSent(false);
                }}
              >
                <option value="email">
                  {w("Email link", "Liên kết email")}
                </option>
                <option value="phone">{w("SMS code", "Mã SMS")}</option>
              </select>
            </Field>
            <Field
              label={
                method === "email"
                  ? w("Invited email", "Email được mời")
                  : w("Vietnam phone (+84)", "Số điện thoại Việt Nam (+84)")
              }
            >
              <input
                required
                type={method === "email" ? "email" : "tel"}
                value={identity}
                onChange={(e) => {
                  setIdentity(e.target.value);
                  setSent(false);
                }}
                placeholder={method === "phone" ? "+84912345678" : ""}
              />
            </Field>
            {method === "phone" && sent && (
              <Field label={w("SMS verification code", "Mã xác thực SMS")}>
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        <button className="secondary full">
          {token || (method === "phone" && sent)
            ? w("Verify access", "Xác thực truy cập")
            : w("Send sign-in link / code", "Gửi liên kết / mã đăng nhập")}
        </button>
        {sent && (
          <p role="status">
            {w(
              "If this identity has an active invitation or membership, a sign-in message was requested.",
              "Nếu có lời mời hoặc quyền truy cập còn hiệu lực, tin đăng nhập đã được yêu cầu.",
            )}
          </p>
        )}
      </form>
    </section>
  );
}
const denyOptions = [
  "posts.write",
  "replies.write",
  "approvals.write",
  "audit.read",
  "system.read",
];
function GrantFields({
  value,
  onChange,
  owner,
}: {
  value: any;
  onChange: (v: any) => void;
  owner: boolean;
}) {
  const w = useWords();
  return (
    <>
      <Field label={w("Role", "Vai trò")}>
        <select
          value={value.role}
          onChange={(e) => onChange({ ...value, role: e.target.value })}
        >
          {(owner
            ? ["manager", "editor", "agent", "viewer"]
            : ["editor", "agent", "viewer"]
          ).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </Field>
      <Field label={w("Channel access", "Quyền trên kênh")}>
        <select
          value={value.channelScope.join(",")}
          onChange={(e) =>
            onChange({ ...value, channelScope: e.target.value.split(",") })
          }
        >
          <option value="*">{w("All channels", "Tất cả kênh")}</option>
          <option value="facebook">Facebook</option>
          <option value="tiktok">TikTok</option>
        </select>
      </Field>
      <details>
        <summary>
          {w(
            "Remove permissions from this role",
            "Bỏ bớt quyền của vai trò này",
          )}
        </summary>
        {denyOptions.map((p) => (
          <label className="check-row" key={p}>
            <input
              type="checkbox"
              checked={value.deniedPermissions.includes(p)}
              onChange={(e) =>
                onChange({
                  ...value,
                  deniedPermissions: e.target.checked
                    ? [...value.deniedPermissions, p]
                    : value.deniedPermissions.filter((x: string) => x !== p),
                })
              }
            />
            {p}
          </label>
        ))}
      </details>
    </>
  );
}
function Member({
  m,
  owner,
  reload,
}: {
  m: any;
  owner: boolean;
  reload: () => Promise<void>;
}) {
  const w = useWords();
  const [value, setValue] = useState({
    role: m.role,
    channelScope: m.channel_scope,
    deniedPermissions: m.denied_permissions,
  });
  const [error, setError] = useState("");
  return (
    <article className="member-card">
      <strong>{m.name}</strong>
      <p>
        {m.phoneNumber ?? m.email} · {m.role} · {m.channel_scope.join(", ")} ·{" "}
        {m.revoked_at
          ? w("Revoked", "Đã thu hồi")
          : m.twoFactorEnabled
            ? "TOTP"
            : w("No TOTP", "Chưa có TOTP")}
      </p>
      {m.role !== "owner" &&
        !m.revoked_at &&
        (owner || m.role !== "manager") && (
          <details>
            <summary>{w("Manage access", "Quản lý quyền")}</summary>
            <GrantFields value={value} onChange={setValue} owner={owner} />
            <div className="button-row">
              <button
                onClick={() =>
                  void api("/team/members/" + m.user_id, "PATCH", value)
                    .then(reload)
                    .catch((e) => setError(e.message))
                }
              >
                {w("Save & sign out sessions", "Lưu & đăng xuất phiên")}
              </button>
              <button
                onClick={() =>
                  void api("/team/members/" + m.user_id, "PATCH", {
                    ...value,
                    revoke: true,
                  })
                    .then(reload)
                    .catch((e) => setError(e.message))
                }
              >
                {w("Revoke access now", "Thu hồi truy cập ngay")}
              </button>
            </div>
          </details>
        )}
      <Failure error={error} />
    </article>
  );
}
export function Team({ actor }: { actor: Actor }) {
  const w = useWords();
  const [data, setData] = useState<any>({
    members: [],
    invitations: [],
    duty: [],
  });
  const [value, setValue] = useState({
    name: "",
    kind: "email",
    identity: "",
    role: "agent",
    channelScope: ["facebook"],
    deniedPermissions: [] as string[],
  });
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [slots, setSlots] = useState<any[]>([]);
  async function load() {
    const d = await api("/team");
    setData(d);
    setSlots(
      d.duty.map((s: any) => ({
        userId: s.user_id,
        platform: s.platform,
        weekday: s.weekday,
        startHour: s.start_hour,
        endHour: s.end_hour,
      })),
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{w("Team & on-duty coverage", "Nhân sự & lịch trực")}</h1>
          <p>
            {w(
              "24/7/365. Uncovered hours fall back to the owner. All duty times use Asia/Ho_Chi_Minh.",
              "24/7/365. Ngoài ca trực, chủ sở hữu phụ trách. Lịch dùng múi giờ Asia/Ho_Chi_Minh.",
            )}
          </p>
        </div>
      </div>
      <Failure error={error} />
      {result && <p role="status">{result}</p>}
      <div className="workspace-columns equal">
        <section className="panel section">
          <h2>{w("Invite someone", "Mời thành viên")}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api("/team/invitations", "POST", value)
                .then((r) => {
                  setResult(
                    r.delivery === "not_delivered"
                      ? w(
                          "Invitation saved. Configure delivery, then the recipient can request a link/code from Sign in.",
                          "Đã lưu lời mời. Cấu hình gửi tin, rồi người nhận yêu cầu liên kết/mã tại trang đăng nhập.",
                        )
                      : w(
                          "Invitation saved; sign-in message requested.",
                          "Đã lưu lời mời; yêu cầu gửi tin đăng nhập.",
                        ),
                  );
                  return load();
                })
                .catch((e) => setError(e.message));
            }}
          >
            <Field label={w("Member name", "Tên thành viên")}>
              <input
                required
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
            </Field>
            <Field label={w("Invite by", "Mời qua")}>
              <select
                value={value.kind}
                onChange={(e) => setValue({ ...value, kind: e.target.value })}
              >
                <option value="email">Email</option>
                <option value="phone">SMS</option>
              </select>
            </Field>
            <Field label={w("Email or +84 phone", "Email hoặc số +84")}>
              <input
                required
                value={value.identity}
                onChange={(e) =>
                  setValue({ ...value, identity: e.target.value })
                }
              />
            </Field>
            <GrantFields
              value={value}
              onChange={setValue}
              owner={actor.role === "owner"}
            />
            <button className="primary">
              {w("Create invitation", "Tạo lời mời")}
            </button>
          </form>
          <h3>
            {w(
              "Invitations · expire after 7 days",
              "Lời mời · hết hạn sau 7 ngày",
            )}
          </h3>
          {data.invitations.map((i: any) => (
            <p key={i.id}>
              {i.identity} · {i.status}{" "}
              {i.status === "pending" && (
                <button
                  onClick={() =>
                    void api(
                      "/team/invitations/" + i.id + "/revoke",
                      "POST",
                      {},
                    )
                      .then(load)
                      .catch((e) => setError(e.message))
                  }
                >
                  {w("Revoke invitation", "Thu hồi lời mời")}
                </button>
              )}
            </p>
          ))}
        </section>
        <section className="panel section">
          <h2>{w("Members", "Thành viên")}</h2>
          {data.members.map((m: any) => (
            <Member
              key={m.user_id + JSON.stringify(m)}
              m={m}
              owner={actor.role === "owner"}
              reload={load}
            />
          ))}
        </section>
      </div>
      <section className="panel section">
        <h2>{w("On-duty schedule", "Lịch trực")}</h2>
        {slots.map((s, i) => (
          <div className="duty-row" key={i}>
            <select
              aria-label={w("On-duty person", "Người trực")}
              value={s.userId}
              onChange={(e) =>
                setSlots(
                  slots.map((x, j) =>
                    j === i ? { ...x, userId: e.target.value } : x,
                  ),
                )
              }
            >
              {data.members
                .filter((m: any) => !m.revoked_at)
                .map((m: any) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <select
              aria-label={w("Duty channel", "Kênh trực")}
              value={s.platform}
              onChange={(e) =>
                setSlots(
                  slots.map((x, j) =>
                    j === i ? { ...x, platform: e.target.value } : x,
                  ),
                )
              }
            >
              <option>facebook</option>
              <option>tiktok</option>
            </select>
            <select
              aria-label={w("Weekday", "Ngày trong tuần")}
              value={s.weekday}
              onChange={(e) =>
                setSlots(
                  slots.map((x, j) =>
                    j === i ? { ...x, weekday: +e.target.value } : x,
                  ),
                )
              }
            >
              {[
                w("Sun", "CN"),
                w("Mon", "T2"),
                w("Tue", "T3"),
                w("Wed", "T4"),
                w("Thu", "T5"),
                w("Fri", "T6"),
                w("Sat", "T7"),
              ].map((day, n) => (
                <option key={n} value={n}>
                  {day}
                </option>
              ))}
            </select>
            <input
              aria-label={w("Start hour", "Giờ bắt đầu")}
              type="number"
              min={0}
              max={23}
              value={s.startHour}
              onChange={(e) =>
                setSlots(
                  slots.map((x, j) =>
                    j === i ? { ...x, startHour: +e.target.value } : x,
                  ),
                )
              }
            />
            <span>→</span>
            <input
              aria-label={w("End hour", "Giờ kết thúc")}
              type="number"
              min={1}
              max={24}
              value={s.endHour}
              onChange={(e) =>
                setSlots(
                  slots.map((x, j) =>
                    j === i ? { ...x, endHour: +e.target.value } : x,
                  ),
                )
              }
            />
            <button onClick={() => setSlots(slots.filter((_, j) => j !== i))}>
              {w("Remove", "Xóa")}
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            onClick={() =>
              setSlots([
                ...slots,
                {
                  userId: actor.userId,
                  platform: "facebook",
                  weekday: 0,
                  startHour: 0,
                  endHour: 24,
                },
              ])
            }
          >
            {w("Add shift", "Thêm ca")}
          </button>
          <button
            className="primary"
            onClick={() =>
              void api("/team/duty", "POST", { slots })
                .then(load)
                .catch((e) => setError(e.message))
            }
          >
            {w("Save coverage", "Lưu lịch trực")}
          </button>
        </div>
      </section>
    </>
  );
}
export function Sessions({
  actor,
  onDone,
}: {
  actor: Actor;
  onDone: () => Promise<void>;
}) {
  const w = useWords();
  const [data, setData] = useState<any>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const load = () => api("/sessions").then(setData);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel section">
      <h2>{w("Devices & sessions", "Thiết bị & phiên đăng nhập")}</h2>
      <Failure error={error} />
      {data?.sessions.map((s: any) => (
        <article key={s.id} className="member-card">
          <p>{s.userAgent ?? w("Unknown device", "Thiết bị không rõ")}</p>
          <small>
            {s.ipAddress} · {new Date(s.createdAt).toLocaleString()} ·{" "}
            {s.id === data.current ? w("This session", "Phiên này") : ""}
          </small>
          <button
            onClick={() =>
              void api("/sessions/" + s.id + "/revoke", "POST", {})
                .then(async () => {
                  if (s.id === data.current) await onDone();
                  else await load();
                })
                .catch((e) => setError(e.message))
            }
          >
            {w("Sign out this session", "Đăng xuất phiên này")}
          </button>
        </article>
      ))}
      {!actor.passwordAvailable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void api("/access/password", "POST", { password })
              .then(onDone)
              .catch((e) => setError(e.message));
          }}
        >
          <Field
            label={w(
              "Optional password (12+ characters)",
              "Mật khẩu tùy chọn (12+ ký tự)",
            )}
          >
            <input
              required
              type="password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <button>{w("Set password", "Đặt mật khẩu")}</button>
        </form>
      )}
    </section>
  );
}
