CREATE TABLE knowledge_source (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('builtin','csv','xlsx','google_csv','google_api')),dataset text NOT NULL CHECK(dataset IN ('products','shipping_zones','faq','policies','orders')),
 mapping jsonb NOT NULL DEFAULT '{}',config jsonb NOT NULL DEFAULT '{}',max_age_hours numeric NOT NULL DEFAULT 24,
 last_sync_at timestamptz,next_sync_at timestamptz,status text NOT NULL DEFAULT 'empty',created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,id)
);
CREATE TABLE knowledge_version (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,source_id uuid NOT NULL,record_key text NOT NULL,version integer NOT NULL,
 source_row integer NOT NULL,data jsonb NOT NULL,field_timestamps jsonb NOT NULL,content_hash text NOT NULL,
 approved_by text NOT NULL REFERENCES "user"(id),ingested_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id),UNIQUE(source_id,record_key,version),FOREIGN KEY(business_id,source_id) REFERENCES knowledge_source(business_id,id)
);
CREATE TRIGGER knowledge_append_only BEFORE UPDATE OR DELETE ON knowledge_version FOR EACH ROW EXECUTE FUNCTION append_only_audit();
CREATE TABLE knowledge_current (
 business_id uuid NOT NULL,source_id uuid NOT NULL,record_key text NOT NULL,version_id uuid NOT NULL,
 PRIMARY KEY(business_id,source_id,record_key),FOREIGN KEY(business_id,source_id) REFERENCES knowledge_source(business_id,id),FOREIGN KEY(business_id,version_id) REFERENCES knowledge_version(business_id,id)
);
CREATE TABLE knowledge_sync (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,source_id uuid NOT NULL,status text NOT NULL,row_count integer NOT NULL DEFAULT 0,changed_count integer NOT NULL DEFAULT 0,error jsonb,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(business_id,source_id) REFERENCES knowledge_source(business_id,id)
);
CREATE TABLE rule_revision (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),version integer NOT NULL,yaml text NOT NULL,config jsonb NOT NULL,created_by text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(business_id,version)
);
CREATE TRIGGER rule_append_only BEFORE UPDATE OR DELETE ON rule_revision FOR EACH ROW EXECUTE FUNCTION append_only_audit();
CREATE TABLE voice_profile (
 business_id uuid PRIMARY KEY REFERENCES business(id),version integer NOT NULL DEFAULT 1,config jsonb NOT NULL,approved_by text NOT NULL REFERENCES "user"(id),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversation (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,channel_id uuid NOT NULL,external_id text NOT NULL,customer_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('manual','messenger','comment')),status text NOT NULL DEFAULT 'open',assigned_to text REFERENCES "user"(id),last_customer_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,UNIQUE(business_id,id),UNIQUE(channel_id,external_id),FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE TABLE message (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,conversation_id uuid NOT NULL,external_id text NOT NULL,text text NOT NULL,
 from_business boolean NOT NULL DEFAULT false,attachments jsonb NOT NULL DEFAULT '[]',sent_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 UNIQUE(business_id,id),UNIQUE(conversation_id,external_id),FOREIGN KEY(business_id,conversation_id) REFERENCES conversation(business_id,id)
);
CREATE INDEX inbox_unprocessed ON message(received_at) WHERE processed_at IS NULL AND NOT from_business;
CREATE TABLE reply_draft (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,message_id uuid NOT NULL,conversation_id uuid NOT NULL,
 text text NOT NULL,holding_text text NOT NULL,analysis jsonb NOT NULL,facts jsonb NOT NULL DEFAULT '[]',checks jsonb NOT NULL,
 autonomy text NOT NULL,status text NOT NULL,revision integer NOT NULL DEFAULT 1,approved_by text REFERENCES "user"(id),approved_at timestamptz,
 rule_version integer,voice_version integer,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,id),UNIQUE(message_id),FOREIGN KEY(business_id,message_id) REFERENCES message(business_id,id),FOREIGN KEY(business_id,conversation_id) REFERENCES conversation(business_id,id)
);
CREATE TABLE reply_edit (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,draft_id uuid NOT NULL,draft_text text NOT NULL,final_text text NOT NULL,actor_id text NOT NULL REFERENCES "user"(id),created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(business_id,draft_id) REFERENCES reply_draft(business_id,id)
);
CREATE TABLE reply_delivery (
 id uuid PRIMARY KEY,business_id uuid NOT NULL,draft_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN ('reply','holding')),payload jsonb NOT NULL,status text NOT NULL,platform_id text,error text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(draft_id,kind),FOREIGN KEY(business_id,draft_id) REFERENCES reply_draft(business_id,id)
);
CREATE TABLE webhook_event (
 id uuid PRIMARY KEY,provider text NOT NULL,body_hash text NOT NULL UNIQUE,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',error text,received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE llm_call (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),channel_id uuid,operation text NOT NULL,model text NOT NULL,provider text NOT NULL,
 budget_month text NOT NULL,reserved_microusd bigint NOT NULL,charged_microusd bigint NOT NULL DEFAULT 0,status text NOT NULL,
 request_encrypted jsonb NOT NULL,response_encrypted jsonb,usage jsonb,error text,prompt_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
CREATE INDEX llm_budget ON llm_call(business_id,budget_month);
CREATE TABLE notification (
 id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES business(id),user_id text NOT NULL REFERENCES "user"(id),channel_id uuid,
 kind text NOT NULL,transport text NOT NULL CHECK(transport IN ('email','in_app','sms')),subject text NOT NULL,body text NOT NULL,status text NOT NULL DEFAULT 'pending',dedup_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,error text,UNIQUE(business_id,dedup_key,user_id,transport),
 CHECK(kind<>'complaint' OR transport='email'),FOREIGN KEY(business_id,channel_id) REFERENCES channel(business_id,id)
);
