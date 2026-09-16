import { Reports, Analyst } from "./features/reports.js";
import { Team, Passwordless, Sessions } from "./features/team.js";
import { can } from "../shared/permissions.js";
import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import QRCode from "react-qr-code";
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Fish,
  Globe2,
  LayoutDashboard,
  Link2,
  Loader2,
  LockKeyhole,
  LogOut,
  Mail,
  Pause,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Users,
  CalendarDays,
} from "lucide-react";
import {
  Publisher,
  MediaLibrary,
  ChannelControls,
  useWords,
} from "./features/publisher.js";
import { Inbox } from "./features/inbox.js";
import { Knowledge, Rules } from "./features/knowledge.js";
import i18n from "./i18n.js";
import "./style.css";
import type { Actor } from "../server/auth/index.js";

async function api<T = any>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("NETWORK_ERROR");
  }
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? data.code ?? "INTERNAL_ERROR");
  return data;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = React.useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(
        children as React.ReactElement<{
          id?: string;
          "aria-describedby"?: string;
        }>,
        { id, "aria-describedby": hint ? `${id}-hint` : undefined },
      )}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
function ErrorBox({ error }: { error: string }) {
  const { t } = useTranslation();
  return error ? (
    <div className="notice error" role="alert">
      {t(`errors.${error}`, { defaultValue: error.replaceAll("_", " ") })}
    </div>
  ) : null;
}
function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return (
    <span className={`pill ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}
function App() {
  const { t } = useTranslation();
  const [actor, setActor] = useState<Actor | null>(null);
  const [bootstrap, setBootstrap] = useState(false);
  const [challenge, setChallenge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(
    new URLSearchParams(location.search).get("page") ?? "overview",
  );
  const [settings, setSettings] = useState<any>(null);
  const [channels, setChannels] = useState<any[]>([]);
  async function reload() {
    setError("");
    try {
      const b = await api("/bootstrap/status");
      setBootstrap(b.required);
      if (!b.required) {
        try {
          const s = await api("/session");
          setActor(s.actor);
          setChallenge(false);
          void i18n.changeLanguage(s.actor.locale);
          if (!s.actor.mfaRequired) {
            const [v, ch] = await Promise.all([
              api("/settings"),
              api("/channels"),
            ]);
            setSettings(v);
            setChannels(ch.channels);
          }
        } catch (e) {
          if ((e as Error).message === "UNAUTHENTICATED") {
            setActor(null);
            setChallenge(false);
          } else throw e;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    document.documentElement.lang = i18n.language;
  }, [i18n.language]);
  function navigate(p: string) {
    setPage(p);
    history.replaceState(null, "", `/?page=${p}`);
  }
  async function language(value: string) {
    void i18n.changeLanguage(value);
    if (actor && !actor.mfaRequired) {
      await api("/preferences", "PATCH", {
        locale: value,
        timezone: actor.timezone,
      });
      setActor({ ...actor, locale: value as "en" | "vi" });
    }
  }
  const localeControl = (
    <select
      aria-label={t("locale")}
      value={i18n.language}
      onChange={(e) =>
        void language(e.target.value).catch((e) => setError(e.message))
      }
    >
      <option value="vi">Tiếng Việt</option>
      <option value="en">English</option>
    </select>
  );
  if (loading)
    return (
      <div className="loading">
        <Loader2 className="spin" />
        {t("loading")}
      </div>
    );
  if (!actor || actor.mfaRequired)
    return (
      <div className="auth-layout">
        <aside className="auth-story">
          <Brand />
          <div>
            <span className="eyebrow">HELPA / SOCIAL BACK OFFICE</span>
            <h1>{t("loginDesc")}</h1>
            <p>{t("intro")}</p>
            <div className="art-sea">
              <div className="art-ring" />
              <Fish size={90} strokeWidth={1} />
              <span className="art-caption">24/7 · Asia/Ho_Chi_Minh</span>
            </div>
          </div>
          <span className="story-bottom">
            <ShieldCheck size={16} /> {t("facts")}
          </span>
        </aside>
        <main className="auth-main">
          <div className="locale-control">{localeControl}</div>
          <div className="auth-card">
            <ErrorBox error={error} />
            {actor || challenge ? (
              <Mfa
                actor={actor ?? ({ mfaEnrolled: true } as Actor)}
                onDone={reload}
              />
            ) : (
              <Login
                bootstrap={bootstrap}
                onDone={reload}
                onChallenge={() => setChallenge(true)}
              />
            )}
          </div>
        </main>
      </div>
    );
  const nav = [
    ["overview", LayoutDashboard],
    ["reports", Activity],
    ["analyst", Sparkles],
    ["publisher", CalendarDays],
    ["media", Fish],
    ["inbox", Mail],
    ["knowledge", ScrollText],
    ["rules", ShieldCheck],
    ["team", Users],
    ["security", ShieldCheck],
    ["channels", Link2],
    ["audit", ScrollText],
    ["system", Activity],
    ["settings", Settings2],
  ] as const;
  const canInspect = ["owner", "manager", "viewer"].includes(actor.role);
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <Brand />
        <div className="nav-label">{t("workspace")}</div>
        <nav>
          {nav
            .filter(
              ([p]) =>
                (p !== "team" || ["owner", "manager"].includes(actor.role)) &&
                (p !== "audit" ||
                  can(
                    actor.role,
                    actor.channelScope,
                    "audit.read",
                    undefined,
                    actor.deniedPermissions,
                  )) &&
                (p !== "system" ||
                  can(
                    actor.role,
                    actor.channelScope,
                    "system.read",
                    undefined,
                    actor.deniedPermissions,
                  )) &&
                (!["knowledge", "rules"].includes(p) ||
                  (["owner", "manager"].includes(actor.role) &&
                    actor.channelScope.includes("*"))) &&
                (p !== "inbox" ||
                  ["owner", "manager", "agent"].includes(actor.role)),
            )
            .map(([p, Icon]) => (
              <button
                key={p}
                className={page === p ? "active" : ""}
                onClick={() => navigate(p)}
              >
                <Icon size={19} />
                {t(p)}
                {page === p && <span className="nav-current" />}
              </button>
            ))}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">{actor.name.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{actor.name}</strong>
            <small>
              {t(`role${actor.role[0].toUpperCase() + actor.role.slice(1)}`)}
            </small>
          </div>
          <button
            aria-label={t("signOut")}
            onClick={() =>
              void api("/auth/sign-out", "POST", {})
                .then(() => {
                  setActor(null);
                  setSettings(null);
                })
                .catch((e) => setError(e.message))
            }
          >
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="main-layout">
        <header className="topbar">
          <span className="breadcrumb">
            Helpa <ChevronRight size={14} /> {t(page)}
          </span>
          <div>
            <span className="timezone">
              <Clock3 size={14} />
              {actor.timezone}
            </span>
            {localeControl}
            <button
              className="header-logout"
              aria-label={t("signOut")}
              onClick={() =>
                void api("/auth/sign-out", "POST", {}).then(() => {
                  setActor(null);
                  setSettings(null);
                })
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <main className="content">
          <ErrorBox error={error} />
          <div
            className={`mode-banner ${settings?.mode === "live" ? "warning" : ""}`}
          >
            <ShieldCheck size={19} />
            <strong>{t(settings?.mode === "live" ? "live" : "dryRun")}</strong>
            <span>
              {t(settings?.mode === "live" ? "liveBanner" : "dryBanner")}
            </span>
          </div>
          {page === "overview" ? (
            <Overview
              settings={settings}
              channels={channels}
              navigate={navigate}
            />
          ) : page === "reports" ? (
            <Reports channels={channels} />
          ) : page === "analyst" ? (
            <Analyst actor={actor} navigate={navigate} />
          ) : page === "publisher" ? (
            <Publisher actor={actor} channels={channels} />
          ) : page === "media" ? (
            <MediaLibrary actor={actor} />
          ) : page === "inbox" ? (
            <Inbox actor={actor} channels={channels} />
          ) : page === "knowledge" ? (
            <Knowledge />
          ) : page === "rules" ? (
            <Rules />
          ) : page === "team" ? (
            <Team actor={actor} />
          ) : page === "security" ? (
            <>
              <Sessions actor={actor} onDone={reload} />
              {!actor.mfaEnrolled && (
                <section className="panel section">
                  <Mfa actor={actor} onDone={reload} />
                </section>
              )}
            </>
          ) : page === "channels" ? (
            <Channels actor={actor} reload={reload} />
          ) : page === "audit" ? (
            <Audit actor={actor} />
          ) : page === "system" ? (
            <System actor={actor} />
          ) : (
            <Settings actor={actor} settings={settings} reload={reload} />
          )}
        </main>
        <footer>
          Helpa <span>·</span> {t("foundation")} <span>·</span>{" "}
          {t("coverageSub")}
        </footer>
      </div>
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Fish size={26} strokeWidth={1.7} />
      </span>
      <span>
        helpa<span className="brand-period">.</span>
      </span>
    </div>
  );
}
function Login({
  bootstrap,
  onDone,
  onChallenge,
}: {
  bootstrap: boolean;
  onDone: () => Promise<void>;
  onChallenge: () => void;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const result = await api(
        bootstrap ? "/bootstrap" : "/auth/sign-in/email",
        "POST",
        values,
      );
      if (result.twoFactorRedirect) onChallenge();
      else await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="form-icon">
        <LockKeyhole />
      </span>
      <h1>{t(bootstrap ? "setupTitle" : "loginTitle")}</h1>
      <p className="muted">{t(bootstrap ? "setupDesc" : "mfaDesc")}</p>
      <ErrorBox error={error} />
      <form onSubmit={submit}>
        {bootstrap && (
          <>
            <Field label={t("name")}>
              <input name="name" autoComplete="name" required maxLength={100} />
            </Field>
            <Field label={t("businessName")}>
              <input
                name="businessName"
                autoComplete="organization"
                required
                maxLength={100}
              />
            </Field>
            <Field label={t("bootstrapToken")} hint={t("bootstrapHelp")}>
              <input name="token" type="password" autoComplete="off" required />
            </Field>
          </>
        )}
        <Field label={t("email")}>
          <input name="email" type="email" autoComplete="username" required />
        </Field>
        <Field
          label={t("password")}
          hint={bootstrap ? t("passwordHint") : undefined}
        >
          <input
            name="password"
            type="password"
            autoComplete={bootstrap ? "new-password" : "current-password"}
            required
            minLength={bootstrap ? 12 : 1}
          />
        </Field>
        <button className="primary full" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : null}
          {t(bootstrap ? "createOwner" : "login")}
          <ArrowUpRight size={18} />
        </button>
      </form>
      {!bootstrap && <Passwordless onDone={onDone} />}
    </>
  );
}
function Mfa({ actor, onDone }: { actor: Actor; onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<{
    totpURI: string;
    backupCodes: string[];
  } | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function enroll(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSetup(
        await api(
          "/auth/two-factor/enable",
          "POST",
          actor.passwordAvailable ? { password } : {},
        ),
      );
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        `/auth/two-factor/${recovery ? "verify-backup-code" : "verify-totp"}`,
        "POST",
        { code, trustDevice: false },
      );
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="form-icon">
        <ShieldCheck />
      </span>
      <h1>{t("mfaTitle")}</h1>
      <p className="muted">{t("mfaDesc")}</p>
      <ErrorBox error={error} />
      {!actor.mfaEnrolled && !setup ? (
        <form onSubmit={enroll}>
          {actor.passwordAvailable && (
            <Field label={t("currentPassword")}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </Field>
          )}
          <button className="primary full" disabled={busy}>
            {t("enroll")}
          </button>
        </form>
      ) : (
        <>
          {setup && (
            <>
              <div className="qr">
                <QRCode value={setup.totpURI} size={164} />
                <small>{t("scan")}</small>
              </div>
              <div className="recovery-codes">
                <strong>{t("backupCodes")}</strong>
                <p>{t("backupHelp")}</p>
                <code>{setup.backupCodes.join("  ")}</code>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={saved}
                    onChange={(e) => setSaved(e.target.checked)}
                    required
                  />
                  {t("codesSaved")}
                </label>
              </div>
            </>
          )}
          <form onSubmit={verify}>
            <Field label={t(recovery ? "recoveryCode" : "code")}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={recovery ? "text" : "numeric"}
                autoComplete="one-time-code"
                pattern={recovery ? undefined : "[0-9]{6}"}
                required
                autoFocus
              />
            </Field>
            <button
              className="primary full"
              disabled={busy || (!!setup && !saved)}
            >
              {t("verify")}
            </button>
          </form>
          {!setup && (
            <button
              className="text-button"
              onClick={() => {
                setRecovery(!recovery);
                setCode("");
                setError("");
              }}
            >
              {t(recovery ? "useTotp" : "useRecovery")}
            </button>
          )}
        </>
      )}
      <button
        className="text-button"
        onClick={() => void api("/auth/sign-out", "POST", {}).then(onDone)}
      >
        {t("signOut")}
      </button>
    </>
  );
}
function Title({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">HELPA / BACK OFFICE</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Overview({
  settings,
  channels,
  navigate,
}: {
  settings: any;
  channels: any[];
  navigate: (p: string) => void;
}) {
  const { t } = useTranslation();
  const b = settings?.business;
  return (
    <>
      <Title title={t("welcome")} description={t("intro")} />
      <div className="stats">
        <Stat
          icon={<Link2 />}
          label={t("connected")}
          value={String(
            channels.filter((c) => c.status === "connected").length,
          )}
          detail={t("connectedSub")}
        />
        <Stat
          icon={<ShieldCheck />}
          label={t("mode")}
          value={t(settings?.mode === "live" ? "live" : "dryRun")}
          detail={t("modeSub")}
        />
        <Stat
          icon={<Clock3 />}
          label={t("coverage")}
          value="24/7"
          detail={t("coverageSub")}
        />
        <Stat
          icon={<Mail />}
          label={t("complaints")}
          value={t("emailOnly")}
          detail={t("humanHandled")}
        />
      </div>
      <div className="overview-grid">
        <section className="card connect-card">
          <span className="large-icon">
            <Link2 size={30} />
          </span>
          <div>
            <span className="eyebrow">FACEBOOK & TIKTOK</span>
            <h2>{t("openChannels")}</h2>
            <p>{t("channelsIntro")}</p>
            <button className="primary" onClick={() => navigate("channels")}>
              {t("openChannels")}
              <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="connect-orbit">
            <span>f</span>
            <span>♪</span>
          </div>
        </section>
        <section className="card guards">
          <h2>{t("guardrails")}</h2>
          {[
            [Pause, "pause", "pauseDetail", b?.auto_replies_paused],
            [
              CheckCircle2,
              "approvals",
              "approvalDetail",
              b?.posts_require_approval,
            ],
            [LockKeyhole, "facts", "factsDetail", true],
          ].map(([Icon, title, desc, on]: any) => (
            <div className="guard" key={title}>
              <Icon size={19} />
              <div>
                <strong>{t(title)}</strong>
                <p>{t(desc)}</p>
              </div>
              <span className={on ? "enabled" : "muted"}>
                {t(on ? "on" : "off")}
              </span>
            </div>
          ))}
        </section>
      </div>
      <section className="next-card">
        <div>
          <Sparkles size={21} />
          <h3>{t("next")}</h3>
        </div>
        <p>{t("nextText")}</p>
      </section>
      <p className="footnote">
        <CircleHelp size={15} />
        {t("phaseNote")}
      </p>
    </>
  );
}
function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="stat card">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}
function Channels({
  actor,
  reload,
}: {
  actor: Actor;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<any>(null);
  const [pending, setPending] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = actor.role === "owner";
  async function load() {
    const d = await api("/channels");
    setData(d);
    if (owner) setPending(await api("/channels/facebook/pending"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await api("/channels/facebook/start", "POST", {});
      location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function select(pageId: string) {
    setBusy(true);
    setError("");
    try {
      await api("/channels/facebook/select", "POST", {
        selection: pending.selection,
        pageId,
      });
      await load();
      await reload();
      history.replaceState(null, "", "/?page=channels");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(id: string) {
    setBusy(true);
    try {
      await api(`/channels/${id}/disconnect`, "POST", {});
      await load();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const connection = new URLSearchParams(location.search).get("connection");
  return (
    <>
      <Title
        title={t("channels")}
        description={t("channelsIntro")}
        action={
          owner ? (
            <button
              className="primary"
              disabled={busy || !data?.facebookConfigured}
              onClick={() => void connect()}
            >
              <Link2 size={17} />
              {t("connectFacebook")}
            </button>
          ) : undefined
        }
      />
      <ErrorBox error={error} />
      {connection && (
        <div className="notice">
          {t(
            connection === "select"
              ? "selectionReady"
              : connection === "failed"
                ? "connectionFailed"
                : "connectionCancelled",
          )}
        </div>
      )}
      {owner && !data?.facebookConfigured && (
        <div className="notice">
          <Terminal size={18} />
          {t("configMeta")}
        </div>
      )}
      {pending?.selection && (
        <section className="card section">
          <h2>{t("choosePage")}</h2>
          {!pending.pages.length ? (
            <p>{t("noPages")}</p>
          ) : (
            pending.pages.map((p: any) => (
              <div className="selection-row" key={p.id}>
                <div>
                  <strong>{p.name}</strong>
                  <small>{p.id}</small>
                </div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void select(p.id)}
                >
                  {t("selectPage")}
                </button>
              </div>
            ))
          )}
        </section>
      )}
      <div className="channel-grid">
        {!data?.channels.some((c: any) => c.platform === "facebook") && (
          <section className="card channel-card">
            <div className="platform-icon facebook">f</div>
            <h2>{t("connectFirst")}</h2>
            <p>{t("connectDesc")}</p>
            <Pill>
              {t(data?.facebookConfigured ? "configured" : "notConfigured")}
            </Pill>
          </section>
        )}
        {data?.channels.map((ch: any) => (
          <section className="card channel-card" key={ch.id}>
            <div className="channel-top">
              <div className={`platform-icon ${ch.platform}`}>
                {ch.platform === "facebook" ? "f" : "♪"}
              </div>
              <Pill tone={ch.status === "connected" ? "green" : "neutral"}>
                {t(
                  ch.status === "connected"
                    ? ch.mode === "live"
                      ? "live"
                      : ch.mode === "manual"
                        ? "manual"
                        : "dryRun"
                    : ch.status === "disconnected"
                      ? "disconnected"
                      : "manual",
                )}
              </Pill>
            </div>
            <h2>{ch.display_name}</h2>
            <ChannelControls
              actor={actor}
              channel={ch}
              reload={async () => {
                await load();
                await reload();
              }}
            />
            {ch.external_id && <p className="mono">{ch.external_id}</p>}
            {ch.platform === "tiktok" ? (
              <p>{t("tiktokNote")}</p>
            ) : ch.status === "connected" ? (
              <>
                <dl>
                  <dt>{t("tokenExpiry")}</dt>
                  <dd>
                    {ch.token_expiry_kind === "known"
                      ? formatTime(ch.token_expires_at, actor)
                      : t(
                          ch.token_expiry_kind === "no_scheduled_expiry"
                            ? "noExpiry"
                            : "unknown",
                        )}
                  </dd>
                  {ch.token_expires_at &&
                    Date.parse(ch.token_expires_at) <
                      Date.now() + 7 * 86400000 && (
                      <dd className="expiry-warning">{t("expiresSoon")}</dd>
                    )}
                  <dt>{t("scopes")}</dt>
                  <dd className="scopes">
                    {ch.granted_scopes.map((s: string) => (
                      <code key={s}>{s}</code>
                    ))}
                  </dd>
                </dl>
                {owner && (
                  <details>
                    <summary>{t("disconnect")}</summary>
                    <p>{t("disconnectNote")}</p>
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => void disconnect(ch.id)}
                    >
                      {t("disconnect")}
                    </button>
                  </details>
                )}
              </>
            ) : null}
          </section>
        ))}
      </div>
    </>
  );
}
function formatTime(date: string, actor: Actor) {
  return new Intl.DateTimeFormat(actor.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: actor.timezone,
  }).format(new Date(date));
}
function Audit({ actor }: { actor: Actor }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<any[]>([]);
  const [actorFilter, setActorFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const params = () =>
    new URLSearchParams({
      action: filter,
      actorId: actorFilter,
      ...(channelFilter ? { channelId: channelFilter } : {}),
      ...(from ? { from: new Date(from).toISOString() } : {}),
      ...(to ? { to: new Date(to).toISOString() } : {}),
    }).toString();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  async function load() {
    try {
      setEvents((await api(`/audit?${params()}`)).events);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <Title title={t("audit")} description={t("auditIntro")} />
      <ErrorBox error={error} />
      <form
        className="filter-row"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          aria-label={t("filterAction")}
          placeholder={t("filterAction")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <input
          aria-label={t("actor")}
          placeholder={t("actor")}
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
        />
        <input
          aria-label="Channel ID"
          placeholder="Channel ID"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        />
        <input
          aria-label="From"
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <input
          aria-label="Until"
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        <button className="secondary">{t("apply")}</button>
        <a className="secondary" href={"/api/audit/export?" + params()}>
          CSV ↓
        </a>
      </form>
      <section className="card table-card">
        <table>
          <thead>
            <tr>
              <th>{t("event")}</th>
              <th>{t("actor")}</th>
              <th>{t("time")}</th>
              <th>{t("details")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  <strong>{e.action}</strong>
                  <small>{e.channel}</small>
                </td>
                <td>
                  {e.actor_type}
                  <small className="mono truncate">{e.actor_id}</small>
                </td>
                <td>{formatTime(e.created_at, actor)}</td>
                <td>
                  <details>
                    <summary>{t("details")}</summary>
                    <pre>{JSON.stringify(e.payload, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!events.length && <div className="empty">{t("noEvents")}</div>}
      </section>
    </>
  );
}
function System({ actor }: { actor: Actor }) {
  const { t } = useTranslation();
  const w = useWords();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await api("/system"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, []);
  async function probe() {
    setBusy(true);
    try {
      await api("/system/dry-run-probe", "POST", {});
      setQueued(true);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title
        title={t("system")}
        description={t("systemIntro")}
        action={
          <button className="secondary" onClick={() => void load()}>
            {t("refresh")}
          </button>
        }
      />
      <ErrorBox error={error} />
      <div className="stats three">
        <Stat
          icon={<Activity />}
          label={t("database")}
          value={data ? t("healthy") : "—"}
          detail="PostgreSQL"
        />
        <Stat
          icon={<Activity />}
          label={t("worker")}
          value={t(data?.worker?.healthy ? "healthy" : "waiting")}
          detail={
            data?.worker ? formatTime(data.worker.last_seen_at, actor) : "—"
          }
        />
        <Stat
          icon={<Clock3 />}
          label={t("queue")}
          value={String(
            data?.jobs?.reduce(
              (n: number, j: any) =>
                n +
                (["created", "retry", "active"].includes(j.state)
                  ? j.count
                  : 0),
              0,
            ) ?? 0,
          )}
          detail="pg-boss"
        />
      </div>
      <section className="card section">
        <div className="section-heading">
          <div>
            <h2>{t("runProbe")}</h2>
            <p>{t("probeHelp")}</p>
          </div>
          {actor.role === "owner" && (
            <button
              className="primary"
              disabled={busy || data?.mode !== "dry_run"}
              onClick={() => void probe()}
            >
              <ShieldCheck size={18} />
              {t("runProbe")}
            </button>
          )}
        </div>
        {queued && (
          <p className="success-text" role="status">
            <Check size={16} />
            {t("probeQueued")}
          </p>
        )}
        <div className="job-states">
          {data?.jobs?.map((j: any) => (
            <Pill key={j.state}>
              {j.state}: {j.count}
            </Pill>
          ))}
        </div>
      </section>
      <section className="card section">
        <h2>{t("outbound")}</h2>
        {!data?.operations?.length ? (
          <div className="empty compact">{t("noOutbound")}</div>
        ) : (
          data.operations.map((op: any) => (
            <article className="operation" key={op.id}>
              <div>
                <Pill tone="green">
                  {op.outcome === "would_have_sent"
                    ? t("wouldHaveSent")
                    : op.outcome}
                </Pill>
                <small>{formatTime(op.created_at, actor)}</small>
              </div>
              <pre>{JSON.stringify(op.payload, null, 2)}</pre>
              <small className="mono">{op.operation_key}</small>
            </article>
          ))
        )}
      </section>
      <div className="stats two">
        {["webhooks", "knowledge"].map((key) => (
          <Stat
            key={key}
            icon={<Clock3 />}
            label={t(key)}
            value={data?.[key]?.status ?? t("notStarted")}
            detail={
              key === "webhooks"
                ? `${data?.webhooks?.channels?.filter((c: any) => c.last_event).length ?? 0} / ${data?.webhooks?.channels?.length ?? 0}`
                : data?.knowledge?.lastSync
                  ? formatTime(data.knowledge.lastSync, actor)
                  : t("notStarted")
            }
          />
        ))}
      </div>
      {actor.role === "owner" && (
        <div className="report-grid">
          <section className="card section">
            <h2>{w("Model usage · USD", "Chi phí mô hình · USD")}</h2>
            <p>
              {w(
                "Reservations enforce the cap, including uncertain calls. Charged usage is reported separately.",
                "Khoản dự trù giới hạn ngân sách, kể cả yêu cầu chưa rõ kết quả. Chi phí thực tế được báo cáo riêng.",
              )}
            </p>
            {!data?.llm?.length && (
              <p>
                {w("No model calls recorded", "Chưa ghi nhận yêu cầu mô hình")}
              </p>
            )}
            {data?.llm?.map((r: any) => (
              <p key={r.budget_month}>
                {r.budget_month} · {r.calls} {w("calls", "yêu cầu")} ·{" "}
                {w("Reserved", "Dự trù")} $
                {(Number(r.reserved_microusd) / 1e6).toFixed(4)} ·{" "}
                {w("Charged", "Thực tế")} $
                {(Number(r.charged_microusd) / 1e6).toFixed(4)}
              </p>
            ))}
          </section>
          <section className="card section">
            <h2>{w("Delivery & ingestion", "Gửi thông báo & nhận dữ liệu")}</h2>
            <p>
              {w("Failed webhook events", "Sự kiện webhook lỗi")}:{" "}
              {data?.webhooks?.failures ?? "—"}
            </p>
            {data?.webhooks?.recovery?.map((event: any) => (
              <article className="operation" key={event.id}>
                <strong>
                  {event.provider} · {event.status} · {event.attempts}{" "}
                  {w("attempts", "lần thử")}
                </strong>
                <small>
                  {event.id} · {formatTime(event.received_at, actor)}
                </small>
                <p>{event.error}</p>
                {event.status === "pending" ? (
                  <p>
                    {w("Next retry", "Thử lại lúc")}:{" "}
                    {formatTime(event.next_attempt_at, actor)}
                  </p>
                ) : (
                  <button
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(
                          `/system/webhooks/${event.id}/retry`,
                          "POST",
                          {},
                        );
                        await load();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {w("Retry failed event", "Thử lại sự kiện lỗi")}
                  </button>
                )}
              </article>
            ))}
            {data?.webhooks?.channels?.map((r: any) => (
              <p key={r.id}>
                {r.display_name}:{" "}
                {r.last_event
                  ? formatTime(r.last_event, actor)
                  : w("No event yet", "Chưa có sự kiện")}
              </p>
            ))}
            {data?.notifications?.map((r: any) => (
              <p key={r.transport + r.status}>
                {r.transport} · {r.status}: {r.count}
              </p>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
function Settings({
  actor,
  settings,
  reload,
}: {
  actor: Actor;
  settings: any;
  reload: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const b = settings?.business;
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState(b?.llm_provider ?? "anthropic");
  const owner = actor.role === "owner";
  if (!b) return null;
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    const v = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("/settings", "PATCH", {
        version: b.settings_version,
        name: v.name,
        autoRepliesPaused: v.pause === "on",
        postsRequireApproval: v.approvals === "on",
        llmProvider: v.provider,
        llmModel: v.model,
        llmMonthlyCapUsd: Number(v.cap),
      });
      await reload();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Title title={t("settings")} description={t("settingsIntro")} />
      <ErrorBox error={error} />
      {saved && (
        <div className="notice success" role="status">
          {t("saved")}
        </div>
      )}
      {!owner && <div className="notice">{t("readOnly")}</div>}
      <form onSubmit={save} key={b.settings_version}>
        <fieldset disabled={!owner || busy}>
          <section className="card section">
            <div className="form-grid">
              <Field label={t("businessName")}>
                <input
                  name="name"
                  defaultValue={b.name}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label={t("businessTimezone")}>
                <input value="Asia/Ho_Chi_Minh" readOnly />
              </Field>
            </div>
            <label className="toggle-row">
              <div>
                <strong>{t("pause")}</strong>
                <p>{t("pauseDetail")}</p>
              </div>
              <input
                name="pause"
                type="checkbox"
                defaultChecked={b.auto_replies_paused}
              />
            </label>
            <label className="toggle-row">
              <div>
                <strong>{t("approvals")}</strong>
                <p>{t("approvalDetail")}</p>
              </div>
              <input
                name="approvals"
                type="checkbox"
                defaultChecked={b.posts_require_approval}
              />
            </label>
          </section>
          <section className="card section">
            <h2>{t("llm")}</h2>
            <p>{t("llmHelp")}</p>
            <div className="form-grid">
              <Field label={t("provider")}>
                <select
                  name="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  <option value="anthropic">Anthropic · Claude</option>
                  <option value="openai">OpenAI API</option>
                </select>
              </Field>
              <Field label={t("model")}>
                <input
                  name="model"
                  defaultValue={b.llm_model}
                  maxLength={100}
                />
              </Field>
              <Field label={t("cap")}>
                <input
                  name="cap"
                  type="number"
                  min="0"
                  max="100000"
                  step="0.01"
                  defaultValue={b.llm_monthly_cap_usd}
                  required
                />
              </Field>
            </div>
            <Pill tone={settings.providers[provider] ? "green" : "neutral"}>
              {t(settings.providers[provider] ? "keyReady" : "keyMissing")}
            </Pill>
          </section>
          <section className="card section">
            <h2>{t("notifications")}</h2>
            <p>{t("notificationsHelp")}</p>
            <div className="job-states">
              <Pill>24/7/365</Pill>
              <Pill>{t("emailOnly")}</Pill>
              <Pill>Twilio OTP · Phase 3</Pill>
            </div>
          </section>
          {owner && (
            <button className="primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={16} />
              ) : (
                <Check size={16} />
              )}{" "}
              {t("save")}
            </button>
          )}
        </fieldset>
      </form>
      <section className="card section preference">
        <Field label={t("displayTimezone")}>
          <select
            value={actor.timezone}
            onChange={(e) =>
              void api("/preferences", "PATCH", {
                locale: actor.locale,
                timezone: e.target.value,
              })
                .then(reload)
                .catch((e) => setError(e.message))
            }
          >
            <option>Asia/Ho_Chi_Minh</option>
            <option>America/Los_Angeles</option>
            <option>UTC</option>
          </select>
        </Field>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
