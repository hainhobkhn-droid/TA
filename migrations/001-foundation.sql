CREATE TABLE "user" (
  id text PRIMARY KEY, name text NOT NULL, email text UNIQUE NOT NULL,
  "emailVerified" boolean NOT NULL DEFAULT false, image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "twoFactorEnabled" boolean NOT NULL DEFAULT false
);
CREATE TABLE session (
  id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text UNIQUE NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text, "userAgent" text, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session("userId");
CREATE TABLE account (
  id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  scope text, password text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("providerId", "accountId")
);
CREATE TABLE verification (
  id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE TABLE "twoFactor" (
  id text PRIMARY KEY, secret text NOT NULL, "backupCodes" text NOT NULL,
  "userId" text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  verified boolean DEFAULT true, "failedVerificationCount" integer DEFAULT 0, "lockedUntil" timestamptz
);
CREATE TABLE "rateLimit" (id text PRIMARY KEY, key text UNIQUE, count integer, "lastRequest" bigint);

CREATE TABLE business (
  id uuid PRIMARY KEY, singleton boolean NOT NULL UNIQUE DEFAULT true CHECK (singleton),
  name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  coverage text NOT NULL DEFAULT '24/7/365' CHECK (coverage = '24/7/365'),
  complaint_notification text NOT NULL DEFAULT 'email' CHECK (complaint_notification = 'email'),
  auto_replies_paused boolean NOT NULL DEFAULT true, posts_require_approval boolean NOT NULL DEFAULT true,
  llm_provider text NOT NULL CHECK (llm_provider IN ('openai','anthropic')), llm_model text NOT NULL DEFAULT '',
  llm_monthly_cap_usd numeric(12,2) NOT NULL DEFAULT 0 CHECK (llm_monthly_cap_usd >= 0),
  settings_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE membership (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), user_id text NOT NULL REFERENCES "user"(id),
  role text NOT NULL CHECK (role IN ('owner','manager','editor','agent','viewer')),
  channel_scope text[] NOT NULL DEFAULT '{}', revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(business_id,user_id)
);
CREATE UNIQUE INDEX one_owner ON membership(business_id) WHERE role='owner';
CREATE FUNCTION protect_owner() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner' OR NEW.revoked_at IS NOT NULL OR NEW.user_id <> OLD.user_id OR NEW.business_id <> OLD.business_id) THEN
    RAISE EXCEPTION 'Owner cannot be removed or demoted';
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER membership_owner_guard BEFORE UPDATE OR DELETE ON membership FOR EACH ROW EXECUTE FUNCTION protect_owner();
CREATE TABLE user_preference (
  user_id text PRIMARY KEY REFERENCES "user"(id), locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi','en')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh'
);
CREATE TABLE mfa_session (
  session_id text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE channel (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), platform text NOT NULL CHECK(platform IN ('facebook','tiktok')),
  external_id text, display_name text NOT NULL, mode text NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual','dry_run','live')),
  status text NOT NULL DEFAULT 'manual', credentials_encrypted jsonb, token_expires_at timestamptz,
  token_expiry_kind text NOT NULL DEFAULT 'unknown', granted_scopes text[] NOT NULL DEFAULT '{}',
  capabilities jsonb NOT NULL DEFAULT '{}', connected_at timestamptz, disconnected_at timestamptz,
  UNIQUE(business_id,platform,external_id), UNIQUE(business_id,id)
);
CREATE TABLE oauth_state (
  state_hash text PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), user_id text NOT NULL REFERENCES "user"(id),
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_selection (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), user_id text NOT NULL REFERENCES "user"(id),
  session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  pages_encrypted jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE audit_event (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), actor_id text, actor_type text NOT NULL,
  action text NOT NULL, channel_id uuid, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE INDEX audit_business_time ON audit_event(business_id,created_at DESC);
CREATE FUNCTION append_only_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Audit events are append-only; retention uses a separately reviewed maintenance procedure';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION append_only_audit();
CREATE TABLE outbound_operation (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), channel_id uuid,
  operation_key text NOT NULL, payload jsonb NOT NULL, mode text NOT NULL, outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,operation_key),
  FOREIGN KEY (business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE TABLE system_heartbeat (name text PRIMARY KEY, last_seen_at timestamptz NOT NULL, details jsonb NOT NULL DEFAULT '{}');
CREATE TABLE login_limit (key text PRIMARY KEY, attempts integer NOT NULL DEFAULT 1, resets_at timestamptz NOT NULL);
