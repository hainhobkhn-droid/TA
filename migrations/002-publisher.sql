ALTER TABLE business ADD COLUMN publishing_paused boolean NOT NULL DEFAULT false;
CREATE TABLE media_asset (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), uploaded_by text NOT NULL REFERENCES "user"(id),
 name text NOT NULL, scope text[] NOT NULL, storage_key text NOT NULL UNIQUE, sha256 text NOT NULL,
 bytes bigint NOT NULL, mime text NOT NULL DEFAULT 'application/octet-stream', status text NOT NULL DEFAULT 'processing',
 metadata jsonb NOT NULL DEFAULT '{}', error text, parent_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id), FOREIGN KEY(business_id,parent_id) REFERENCES media_asset(business_id,id)
);
CREATE TABLE post (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), title text NOT NULL, created_by text NOT NULL REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,id)
);
CREATE TABLE post_variant (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, post_id uuid NOT NULL, channel_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'draft', scheduled_at timestamptz,
 approved_revision integer, approved_by text REFERENCES "user"(id), scheduled_by text REFERENCES "user"(id),
 platform_id text, permalink text, error text, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id), FOREIGN KEY(business_id,post_id) REFERENCES post(business_id,id),
 FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE INDEX post_due ON post_variant(status,scheduled_at);
CREATE TABLE post_revision (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, variant_id uuid NOT NULL, revision integer NOT NULL,
 payload jsonb NOT NULL, created_by text NOT NULL REFERENCES "user"(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,variant_id,revision), FOREIGN KEY(business_id,variant_id) REFERENCES post_variant(business_id,id)
);
CREATE TRIGGER revision_append_only BEFORE UPDATE OR DELETE ON post_revision FOR EACH ROW EXECUTE FUNCTION append_only_audit();
CREATE TABLE publish_step (
 id uuid PRIMARY KEY, business_id uuid NOT NULL, variant_id uuid NOT NULL, revision integer NOT NULL,
 name text NOT NULL, payload jsonb NOT NULL, status text NOT NULL, result jsonb, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,variant_id,revision,name), FOREIGN KEY(business_id,variant_id) REFERENCES post_variant(business_id,id)
);
CREATE TABLE recurring_template (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES business(id), title text NOT NULL, created_by text NOT NULL REFERENCES "user"(id),
 weekday integer NOT NULL CHECK(weekday BETWEEN 0 AND 6), local_time text NOT NULL, variants jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(business_id,id)
);
CREATE TABLE recurring_occurrence (
 business_id uuid NOT NULL, template_id uuid NOT NULL, local_date date NOT NULL, post_id uuid NOT NULL,
 PRIMARY KEY(business_id,template_id,local_date), FOREIGN KEY(business_id,template_id) REFERENCES recurring_template(business_id,id),
 FOREIGN KEY(business_id,post_id) REFERENCES post(business_id,id)
);
ALTER TABLE oauth_state ADD COLUMN provider text NOT NULL DEFAULT 'facebook';
