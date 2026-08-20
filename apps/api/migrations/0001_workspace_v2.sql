CREATE TABLE workspace_admin_states (
  tenant_id varchar(128) PRIMARY KEY CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state jsonb NOT NULL CHECK (
    (jsonb_typeof(state) = 'object') IS TRUE
    AND (state ->> 'tenantId' = tenant_id) IS TRUE
  ),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_sessions (
  session_id_hash char(64) PRIMARY KEY CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
  account_id varchar(128) NOT NULL CHECK (account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  signed_out_at timestamptz CHECK (signed_out_at IS NULL OR signed_out_at >= created_at),
  state jsonb NOT NULL CHECK (
    (jsonb_typeof(state) = 'object') IS TRUE
    AND (state ->> 'sessionIdHash' = session_id_hash) IS TRUE
    AND (state ->> 'accountId' = account_id) IS TRUE
    AND ((state ->> 'createdAt')::timestamptz = created_at) IS TRUE
    AND ((state ->> 'expiresAt')::timestamptz = expires_at) IS TRUE
    AND (
      (signed_out_at IS NULL AND NOT (state ? 'signedOutAt'))
      OR (
        signed_out_at IS NOT NULL
        AND ((state ->> 'signedOutAt')::timestamptz = signed_out_at) IS TRUE
      )
    )
  ),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_sessions_account_id_idx ON workspace_sessions (account_id);
CREATE INDEX workspace_sessions_expires_at_idx ON workspace_sessions (expires_at);

CREATE TABLE account_budget_states (
  tenant_id varchar(128) NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  account_id varchar(128) NOT NULL CHECK (account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state jsonb NOT NULL CHECK (
    (jsonb_typeof(state) = 'object') IS TRUE
    AND (state ->> 'tenantId' = tenant_id) IS TRUE
    AND (state ->> 'accountId' = account_id) IS TRUE
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE batch_project_aggregates (
  tenant_id varchar(128) NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  project_id varchar(128) NOT NULL CHECK (project_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision bigint NOT NULL CHECK (revision >= 1),
  normalized_name varchar(240) NOT NULL,
  creation_actor_account_id varchar(128) NOT NULL
    CHECK (creation_actor_account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  creation_request_id varchar(128) NOT NULL
    CHECK (creation_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  creation_payload_hash varchar(128) NOT NULL CHECK (length(creation_payload_hash) >= 1),
  aggregate jsonb NOT NULL CHECK (
    (jsonb_typeof(aggregate) = 'object') IS TRUE
    AND (aggregate #>> '{project,tenantId}' = tenant_id) IS TRUE
    AND (aggregate #>> '{project,id}' = project_id) IS TRUE
    AND (aggregate ->> 'actorAccountId' = creation_actor_account_id) IS TRUE
    AND (aggregate ->> 'requestId' = creation_request_id) IS TRUE
    AND (aggregate ->> 'payloadHash' = creation_payload_hash) IS TRUE
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_project_aggregates_pkey PRIMARY KEY (tenant_id, project_id),
  CONSTRAINT batch_project_aggregates_tenant_normalized_name_key
    UNIQUE (tenant_id, normalized_name),
  CONSTRAINT batch_project_aggregates_creation_request_key
    UNIQUE (tenant_id, creation_actor_account_id, creation_request_id)
);

CREATE INDEX batch_project_aggregates_project_id_idx
  ON batch_project_aggregates (project_id);

CREATE TABLE video_task_aggregates (
  task_id varchar(128) NOT NULL CHECK (task_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  tenant_id varchar(128) NOT NULL CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  project_id varchar(128) NOT NULL CHECK (project_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision bigint NOT NULL CHECK (revision >= 1),
  normalized_name varchar(160) NOT NULL,
  creation_actor_account_id varchar(128)
    CHECK (creation_actor_account_id IS NULL OR creation_actor_account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  creation_request_id varchar(128)
    CHECK (creation_request_id IS NULL OR creation_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  creation_payload_hash varchar(128)
    CHECK (creation_payload_hash IS NULL OR length(creation_payload_hash) >= 1),
  aggregate jsonb NOT NULL CHECK (
    (jsonb_typeof(aggregate) = 'object') IS TRUE
    AND (aggregate #>> '{videoTask,id}' = task_id) IS TRUE
    AND (aggregate #>> '{videoTask,tenantId}' = tenant_id) IS TRUE
    AND (aggregate #>> '{videoTask,batchProjectId}' = project_id) IS TRUE
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (creation_actor_account_id IS NULL AND creation_request_id IS NULL AND creation_payload_hash IS NULL)
    OR
    (creation_actor_account_id IS NOT NULL AND creation_request_id IS NOT NULL AND creation_payload_hash IS NOT NULL)
  ),
  CONSTRAINT video_task_aggregates_pkey PRIMARY KEY (tenant_id, project_id, task_id),
  CONSTRAINT video_task_aggregates_task_id_key UNIQUE (task_id),
  CONSTRAINT video_task_aggregates_project_fkey
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES batch_project_aggregates (tenant_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT video_task_aggregates_project_normalized_name_key
    UNIQUE (tenant_id, project_id, normalized_name)
);

CREATE UNIQUE INDEX video_task_aggregates_creation_request_key
  ON video_task_aggregates (
    tenant_id,
    project_id,
    creation_actor_account_id,
    creation_request_id
  )
  WHERE creation_request_id IS NOT NULL;

CREATE INDEX video_task_aggregates_project_list_idx
  ON video_task_aggregates (tenant_id, project_id, task_id);

ALTER TABLE batch_project_aggregates
  ADD CONSTRAINT batch_project_aggregates_project_id_key UNIQUE (project_id);

CREATE TABLE temporary_asset_project_states (
  tenant_id varchar(128) NOT NULL
    CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  batch_project_id varchar(128) PRIMARY KEY
    CHECK (batch_project_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  envelope jsonb NOT NULL CHECK (
    (jsonb_typeof(envelope) = 'object') IS TRUE
    AND (envelope ->> 'batchProjectId' = batch_project_id) IS TRUE
    AND (jsonb_typeof(envelope -> 'assets') = 'array') IS TRUE
    AND (
      jsonb_array_length(envelope -> 'assets') = jsonb_array_length(
        jsonb_path_query_array(
          envelope,
          '$.assets[*] ? (@.tenantId == $tenantId && @.batchProjectId == $batchProjectId)',
          jsonb_build_object(
            'tenantId', to_jsonb(tenant_id),
            'batchProjectId', to_jsonb(batch_project_id)
          )
        )
      )
    ) IS TRUE
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT temporary_asset_project_states_project_fkey
    FOREIGN KEY (tenant_id, batch_project_id)
    REFERENCES batch_project_aggregates (tenant_id, project_id)
);

CREATE INDEX temporary_asset_project_states_tenant_project_idx
  ON temporary_asset_project_states (tenant_id, batch_project_id);

CREATE TABLE account_run_lock_states (
  tenant_id varchar(128) NOT NULL
    CHECK (tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  account_id varchar(128) NOT NULL
    CHECK (account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  lock_id varchar(128) NOT NULL
    CHECK (lock_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  batch_project_id varchar(128) NOT NULL
    CHECK (batch_project_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  video_task_id varchar(128) NOT NULL
    CHECK (video_task_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  operation varchar(32) NOT NULL
    CHECK (operation IN ('video_generation', 'automatic_editing')),
  acquired_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  envelope jsonb NOT NULL CHECK (
    (jsonb_typeof(envelope) = 'object') IS TRUE
    AND (envelope ->> 'tenantId' = tenant_id) IS TRUE
    AND (envelope ->> 'accountId' = account_id) IS TRUE
    AND (envelope ->> 'id' = lock_id) IS TRUE
    AND (envelope ->> 'batchProjectId' = batch_project_id) IS TRUE
    AND (envelope ->> 'videoTaskId' = video_task_id) IS TRUE
    AND (envelope ->> 'operation' = operation) IS TRUE
    AND ((envelope ->> 'acquiredAt')::timestamptz = acquired_at) IS TRUE
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id),
  UNIQUE (lock_id),
  CONSTRAINT account_run_lock_states_task_fkey
    FOREIGN KEY (tenant_id, batch_project_id, video_task_id)
    REFERENCES video_task_aggregates (tenant_id, project_id, task_id)
);

CREATE INDEX account_run_lock_states_task_idx
  ON account_run_lock_states (tenant_id, batch_project_id, video_task_id);
