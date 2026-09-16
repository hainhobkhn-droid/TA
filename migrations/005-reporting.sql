CREATE TABLE metric_snapshot (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,channel_id uuid NOT NULL,object_id text NOT NULL,metric text NOT NULL,day date NOT NULL,period text NOT NULL,kind text NOT NULL CHECK(kind IN ('daily','cumulative','gauge')),value numeric NOT NULL,source text NOT NULL,source_end_time text,metadata jsonb NOT NULL DEFAULT '{}',fetched_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel_id,object_id,metric,day,period),FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE TRIGGER metric_immutable BEFORE UPDATE OR DELETE ON metric_snapshot FOR EACH ROW EXECUTE FUNCTION append_only_audit();
CREATE TABLE metric_collection (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,channel_id uuid NOT NULL,status text NOT NULL,reason text,rows integer NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
ALTER TABLE channel ADD COLUMN next_metrics_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE insight (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,channel_id uuid NOT NULL,detector text NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,evidence jsonb NOT NULL,recommendation jsonb NOT NULL,status text NOT NULL DEFAULT 'open',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(channel_id,detector,period_end),FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE TABLE proposal (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),channel_id uuid,kind text NOT NULL CHECK(kind IN ('faq','rules','narrative')),content jsonb NOT NULL,evidence jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',created_by text NOT NULL REFERENCES "user"(id),reviewed_by text REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE TABLE inquiry_order_link (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,conversation_id uuid NOT NULL,order_version_id uuid NOT NULL,source_id uuid NOT NULL,record_key text NOT NULL,linked_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,source_id,record_key),FOREIGN KEY(business_id,conversation_id) REFERENCES conversation(business_id,id),FOREIGN KEY(business_id,order_version_id) REFERENCES knowledge_version(business_id,id)
);
CREATE TRIGGER order_link_immutable BEFORE UPDATE OR DELETE ON inquiry_order_link FOR EACH ROW EXECUTE FUNCTION append_only_audit();
ALTER TABLE notification ADD COLUMN scope_snapshot text[];
