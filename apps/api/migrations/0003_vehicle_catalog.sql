CREATE TABLE vehicle_models (
  tenant_id varchar(128) NOT NULL,
  model_id varchar(128) NOT NULL,
  brand_id varchar(128) NOT NULL,
  series_name varchar(120) NOT NULL,
  model_year integer NOT NULL,
  status varchar(16) NOT NULL,
  created_at timestamptz NOT NULL,
  created_by varchar(128) NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by varchar(128) NOT NULL,
  CONSTRAINT vehicle_models_pkey PRIMARY KEY (tenant_id, model_id),
  CONSTRAINT vehicle_models_model_id_key UNIQUE (model_id),
  CONSTRAINT vehicle_models_identity_key UNIQUE (tenant_id, brand_id, series_name, model_year),
  CONSTRAINT vehicle_models_identifier_check CHECK (
    tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND model_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND brand_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND created_by ~ '^[A-Za-z0-9_-]{1,128}$'
    AND updated_by ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT vehicle_models_values_check CHECK (
    length(btrim(series_name)) BETWEEN 1 AND 120
    AND model_year BETWEEN 2000 AND 2100
    AND status IN ('active', 'archived')
    AND updated_at >= created_at
  )
);

CREATE TABLE vehicle_variants (
  tenant_id varchar(128) NOT NULL,
  variant_id varchar(128) NOT NULL,
  model_id varchar(128) NOT NULL,
  variant_name varchar(120) NOT NULL,
  status varchar(16) NOT NULL,
  current_fact_version bigint NOT NULL,
  created_at timestamptz NOT NULL,
  created_by varchar(128) NOT NULL,
  updated_at timestamptz NOT NULL,
  updated_by varchar(128) NOT NULL,
  CONSTRAINT vehicle_variants_pkey PRIMARY KEY (tenant_id, variant_id),
  CONSTRAINT vehicle_variants_variant_id_key UNIQUE (variant_id),
  CONSTRAINT vehicle_variants_model_name_key UNIQUE (tenant_id, model_id, variant_name),
  CONSTRAINT vehicle_variants_model_fkey FOREIGN KEY (tenant_id, model_id)
    REFERENCES vehicle_models (tenant_id, model_id) ON DELETE RESTRICT,
  CONSTRAINT vehicle_variants_identifier_check CHECK (
    tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND variant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND model_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND created_by ~ '^[A-Za-z0-9_-]{1,128}$'
    AND updated_by ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT vehicle_variants_values_check CHECK (
    length(btrim(variant_name)) BETWEEN 1 AND 120
    AND status IN ('active', 'archived')
    AND current_fact_version BETWEEN 1 AND 9007199254740991
    AND updated_at >= created_at
  )
);

CREATE TABLE vehicle_fact_versions (
  tenant_id varchar(128) NOT NULL,
  variant_id varchar(128) NOT NULL,
  fact_version bigint NOT NULL,
  facts_text text NOT NULL,
  facts_sha256 char(64) NOT NULL,
  validation_index jsonb NOT NULL,
  source_name text NOT NULL,
  source_reference text NOT NULL,
  effective_from date NOT NULL,
  effective_until date,
  created_at timestamptz NOT NULL,
  created_by varchar(128) NOT NULL,
  CONSTRAINT vehicle_fact_versions_pkey PRIMARY KEY (tenant_id, variant_id, fact_version),
  CONSTRAINT vehicle_fact_versions_variant_fkey FOREIGN KEY (tenant_id, variant_id)
    REFERENCES vehicle_variants (tenant_id, variant_id) ON DELETE RESTRICT,
  CONSTRAINT vehicle_fact_versions_identifier_check CHECK (
    tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND variant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND created_by ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT vehicle_fact_versions_values_check CHECK (
    fact_version BETWEEN 1 AND 9007199254740991
    AND length(btrim(facts_text)) BETWEEN 1 AND 100000
    AND facts_sha256 ~ '^[0-9a-f]{64}$'
    AND length(btrim(source_name)) BETWEEN 1 AND 1000
    AND length(btrim(source_reference)) BETWEEN 1 AND 4000
    AND (effective_until IS NULL OR effective_until >= effective_from)
  ),
  CONSTRAINT vehicle_fact_versions_validation_index_check CHECK (
    (jsonb_typeof(validation_index) = 'object') IS TRUE
    AND (jsonb_typeof(validation_index -> 'fixedClaims') = 'array') IS TRUE
    AND (jsonb_typeof(validation_index -> 'optionalClaims') = 'array') IS TRUE
    AND (jsonb_typeof(validation_index -> 'prohibitedClaims') = 'array') IS TRUE
  )
);

ALTER TABLE vehicle_variants
  ADD CONSTRAINT vehicle_variants_current_fact_fkey
  FOREIGN KEY (tenant_id, variant_id, current_fact_version)
  REFERENCES vehicle_fact_versions (tenant_id, variant_id, fact_version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE video_task_vehicle_snapshots (
  snapshot_id varchar(128) NOT NULL,
  tenant_id varchar(128) NOT NULL,
  batch_project_id varchar(128) NOT NULL,
  video_task_id varchar(128) NOT NULL,
  variant_id varchar(128) NOT NULL,
  fact_version bigint NOT NULL,
  facts_text text NOT NULL,
  facts_sha256 char(64) NOT NULL,
  validation_index jsonb NOT NULL,
  locked_at timestamptz NOT NULL,
  locked_by varchar(128) NOT NULL,
  CONSTRAINT video_task_vehicle_snapshots_pkey PRIMARY KEY (tenant_id, batch_project_id, video_task_id),
  CONSTRAINT video_task_vehicle_snapshots_task_fkey
    FOREIGN KEY (tenant_id, batch_project_id, video_task_id)
    REFERENCES video_task_aggregates (tenant_id, project_id, task_id) ON DELETE RESTRICT,
  CONSTRAINT video_task_vehicle_snapshots_fact_fkey
    FOREIGN KEY (tenant_id, variant_id, fact_version)
    REFERENCES vehicle_fact_versions (tenant_id, variant_id, fact_version) ON DELETE RESTRICT,
  CONSTRAINT video_task_vehicle_snapshots_identifier_check CHECK (
    snapshot_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND batch_project_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND video_task_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND variant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND locked_by ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT video_task_vehicle_snapshots_values_check CHECK (
    fact_version BETWEEN 1 AND 9007199254740991
    AND length(btrim(facts_text)) BETWEEN 1 AND 100000
    AND facts_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT video_task_vehicle_snapshots_validation_index_check CHECK (
    (jsonb_typeof(validation_index) = 'object') IS TRUE
    AND (jsonb_typeof(validation_index -> 'fixedClaims') = 'array') IS TRUE
    AND (jsonb_typeof(validation_index -> 'optionalClaims') = 'array') IS TRUE
    AND (jsonb_typeof(validation_index -> 'prohibitedClaims') = 'array') IS TRUE
  )
);

CREATE FUNCTION reject_vehicle_fact_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vehicle fact history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER vehicle_fact_versions_immutable
  BEFORE UPDATE OR DELETE ON vehicle_fact_versions
  FOR EACH ROW EXECUTE FUNCTION reject_vehicle_fact_history_mutation();

CREATE TRIGGER video_task_vehicle_snapshots_immutable
  BEFORE UPDATE OR DELETE ON video_task_vehicle_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_vehicle_fact_history_mutation();

CREATE INDEX vehicle_variants_model_idx
  ON vehicle_variants (tenant_id, model_id, status, variant_name);
CREATE INDEX vehicle_fact_versions_history_idx
  ON vehicle_fact_versions (tenant_id, variant_id, fact_version DESC);
CREATE INDEX video_task_vehicle_snapshots_snapshot_idx
  ON video_task_vehicle_snapshots (snapshot_id);

WITH source_versions AS (
  SELECT
    administration.tenant_id,
    vehicle,
    'model_' || md5(concat_ws('|', administration.tenant_id, vehicle ->> 'brandId', vehicle ->> 'series', vehicle ->> 'modelYear')) AS model_id
  FROM workspace_admin_states AS administration
  CROSS JOIN LATERAL jsonb_array_elements(administration.state -> 'vehicleVersions') AS vehicle
), source_models AS (
  SELECT DISTINCT ON (tenant_id, model_id)
    tenant_id,
    model_id,
    vehicle ->> 'brandId' AS brand_id,
    vehicle ->> 'series' AS series_name,
    (vehicle ->> 'modelYear')::integer AS model_year,
    vehicle ->> 'status' AS status,
    (vehicle ->> 'createdAt')::timestamptz AS created_at,
    vehicle ->> 'createdBy' AS created_by,
    (vehicle ->> 'updatedAt')::timestamptz AS updated_at,
    vehicle ->> 'updatedBy' AS updated_by
  FROM source_versions
  ORDER BY tenant_id, model_id, (vehicle ->> 'version')::bigint DESC
)
INSERT INTO vehicle_models (
  tenant_id, model_id, brand_id, series_name, model_year, status,
  created_at, created_by, updated_at, updated_by
)
SELECT tenant_id, model_id, brand_id, series_name, model_year, status,
       created_at, created_by, updated_at, updated_by
FROM source_models;

WITH source_versions AS (
  SELECT
    administration.tenant_id,
    vehicle,
    'model_' || md5(concat_ws('|', administration.tenant_id, vehicle ->> 'brandId', vehicle ->> 'series', vehicle ->> 'modelYear')) AS model_id
  FROM workspace_admin_states AS administration
  CROSS JOIN LATERAL jsonb_array_elements(administration.state -> 'vehicleVersions') AS vehicle
), current_variants AS (
  SELECT DISTINCT ON (tenant_id, vehicle ->> 'id')
    tenant_id,
    vehicle ->> 'id' AS variant_id,
    model_id,
    vehicle ->> 'trim' AS variant_name,
    vehicle ->> 'status' AS status,
    (vehicle ->> 'version')::bigint AS current_fact_version,
    (vehicle ->> 'createdAt')::timestamptz AS created_at,
    vehicle ->> 'createdBy' AS created_by,
    (vehicle ->> 'updatedAt')::timestamptz AS updated_at,
    vehicle ->> 'updatedBy' AS updated_by
  FROM source_versions
  ORDER BY tenant_id, vehicle ->> 'id', (vehicle ->> 'version')::bigint DESC
)
INSERT INTO vehicle_variants (
  tenant_id, variant_id, model_id, variant_name, status, current_fact_version,
  created_at, created_by, updated_at, updated_by
)
SELECT tenant_id, variant_id, model_id, variant_name, status, current_fact_version,
       created_at, created_by, updated_at, updated_by
FROM current_variants;

WITH source_versions AS (
  SELECT administration.tenant_id, vehicle
  FROM workspace_admin_states AS administration
  CROSS JOIN LATERAL jsonb_array_elements(administration.state -> 'vehicleVersions') AS vehicle
), rendered AS (
  SELECT
    tenant_id,
    vehicle,
    concat_ws(E'\n',
      '车型：' || (vehicle ->> 'series') || ' ' || (vehicle ->> 'modelYear') || ' ' || (vehicle ->> 'trim'),
      (
        SELECT string_agg(claim ->> 'statement', E'\n' ORDER BY ordinal)
        FROM jsonb_array_elements(coalesce(vehicle -> 'fixedClaims', '[]'::jsonb) || coalesce(vehicle -> 'optionalClaims', '[]'::jsonb))
          WITH ORDINALITY AS facts(claim, ordinal)
      )
    ) AS facts_text
  FROM source_versions
)
INSERT INTO vehicle_fact_versions (
  tenant_id, variant_id, fact_version, facts_text, facts_sha256,
  validation_index, source_name, source_reference, effective_from, effective_until,
  created_at, created_by
)
SELECT
  tenant_id,
  vehicle ->> 'id',
  (vehicle ->> 'version')::bigint,
  facts_text,
  encode(sha256(convert_to(facts_text, 'UTF8')), 'hex'),
  jsonb_build_object(
    'fixedClaims', coalesce(vehicle -> 'fixedClaims', '[]'::jsonb),
    'optionalClaims', coalesce(vehicle -> 'optionalClaims', '[]'::jsonb),
    'prohibitedClaims', coalesce(vehicle -> 'prohibitedClaims', '[]'::jsonb)
  ),
  coalesce(vehicle -> 'fixedClaims' -> 0 -> 'evidence' ->> 'sourceName', '历史工作区车型事实'),
  coalesce(vehicle -> 'fixedClaims' -> 0 -> 'evidence' ->> 'sourceReference', vehicle ->> 'id'),
  coalesce((vehicle -> 'fixedClaims' -> 0 -> 'evidence' ->> 'effectiveFrom')::date, (vehicle ->> 'createdAt')::date),
  (vehicle -> 'fixedClaims' -> 0 -> 'evidence' ->> 'effectiveUntil')::date,
  (vehicle ->> 'createdAt')::timestamptz,
  vehicle ->> 'createdBy'
FROM rendered;

WITH source_snapshots AS (
  SELECT
    tasks.tenant_id,
    tasks.project_id,
    tasks.task_id,
    snapshot
  FROM video_task_aggregates AS tasks
  CROSS JOIN LATERAL jsonb_array_elements(tasks.aggregate -> 'taskVehicleSnapshots') AS snapshot
), rendered AS (
  SELECT
    source_snapshots.*,
    concat_ws(E'\n',
      '车型：' || (snapshot ->> 'brand') || ' ' || (snapshot ->> 'series') || ' ' || (snapshot ->> 'modelYear') || ' ' || (snapshot ->> 'trim'),
      (
        SELECT string_agg(claim ->> 'statement', E'\n' ORDER BY ordinal)
        FROM jsonb_array_elements(coalesce(snapshot -> 'fixedClaims', '[]'::jsonb) || coalesce(snapshot -> 'optionalClaims', '[]'::jsonb))
          WITH ORDINALITY AS facts(claim, ordinal)
      )
    ) AS facts_text
  FROM source_snapshots
)
INSERT INTO video_task_vehicle_snapshots (
  snapshot_id, tenant_id, batch_project_id, video_task_id, variant_id, fact_version,
  facts_text, facts_sha256, validation_index, locked_at, locked_by
)
SELECT
  snapshot ->> 'id', tenant_id, project_id, task_id, snapshot ->> 'vehicleId',
  (snapshot ->> 'vehicleVersion')::bigint, facts_text,
  encode(sha256(convert_to(facts_text, 'UTF8')), 'hex'),
  jsonb_build_object(
    'fixedClaims', coalesce(snapshot -> 'fixedClaims', '[]'::jsonb),
    'optionalClaims', coalesce(snapshot -> 'optionalClaims', '[]'::jsonb),
    'prohibitedClaims', coalesce(snapshot -> 'prohibitedClaims', '[]'::jsonb)
  ),
  (snapshot ->> 'createdAt')::timestamptz,
  snapshot ->> 'createdBy'
FROM rendered;
