ALTER TABLE "user" ADD COLUMN "phoneNumber" text UNIQUE, ADD COLUMN "phoneNumberVerified" boolean NOT NULL DEFAULT false;
ALTER TABLE membership ADD COLUMN denied_permissions text[] NOT NULL DEFAULT '{}';
CREATE TABLE invitation (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),user_id text NOT NULL REFERENCES "user"(id),invited_by text NOT NULL REFERENCES "user"(id),
 identity text NOT NULL,kind text NOT NULL CHECK(kind IN ('email','phone')),role text NOT NULL CHECK(role IN ('manager','editor','agent','viewer')),channel_scope text[] NOT NULL,denied_permissions text[] NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz
);
CREATE UNIQUE INDEX one_pending_invitation ON invitation(user_id) WHERE status='pending';
CREATE TABLE phone_challenge (identity_hash text PRIMARY KEY,expires_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 0,code_hash text);
CREATE TABLE duty_slot (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),user_id text NOT NULL REFERENCES "user"(id),platform text NOT NULL CHECK(platform IN ('facebook','tiktok')),weekday integer NOT NULL CHECK(weekday BETWEEN 0 AND 6),start_hour integer NOT NULL CHECK(start_hour BETWEEN 0 AND 23),end_hour integer NOT NULL CHECK(end_hour BETWEEN 1 AND 24),CHECK(end_hour>start_hour),UNIQUE(business_id,platform,weekday,start_hour)
);
ALTER TABLE user_preference ADD COLUMN digest_email boolean NOT NULL DEFAULT false,ADD COLUMN digest_sms boolean NOT NULL DEFAULT false;
ALTER TABLE channel ADD COLUMN token_checked_at timestamptz,ADD COLUMN next_token_check_at timestamptz NOT NULL DEFAULT now(),ADD COLUMN maintenance_error text;
ALTER TABLE post_variant ADD COLUMN next_status_check_at timestamptz NOT NULL DEFAULT now();
