CREATE TABLE media_artifacts (
  artifact_id varchar(128) NOT NULL,
  tenant_id varchar(128) NOT NULL,
  batch_project_id varchar(128) NOT NULL,
  video_task_id varchar(128) NOT NULL,
  stage varchar(32) NOT NULL,
  role varchar(32) NOT NULL,
  artifact_version bigint NOT NULL,
  media_type varchar(128) NOT NULL,
  byte_size bigint NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  duration_ms bigint NOT NULL,
  created_at timestamptz NOT NULL,
  created_by varchar(128) NOT NULL,
  storage_provider_id varchar(128) NOT NULL,
  storage_bucket_name varchar(255) NOT NULL,
  storage_object_key varchar(1024) NOT NULL,
  storage_object_version varchar(1024),
  creation_actor_account_id varchar(128) NOT NULL,
  creation_request_id varchar(128) NOT NULL,
  creation_payload_hash char(64) NOT NULL,
  artifact jsonb NOT NULL,

  CONSTRAINT media_artifacts_pkey PRIMARY KEY (artifact_id),
  CONSTRAINT media_artifacts_task_stage_role_version_key
    UNIQUE (tenant_id, batch_project_id, video_task_id, stage, role, artifact_version),
  CONSTRAINT media_artifacts_creation_request_key
    UNIQUE (
      tenant_id,
      batch_project_id,
      video_task_id,
      creation_actor_account_id,
      creation_request_id
    ),
  CONSTRAINT media_artifacts_object_locator_key
    UNIQUE (
      storage_provider_id,
      storage_bucket_name,
      storage_object_key
    ),
  CONSTRAINT media_artifacts_task_fkey
    FOREIGN KEY (tenant_id, batch_project_id, video_task_id)
    REFERENCES video_task_aggregates (tenant_id, project_id, task_id)
    ON DELETE RESTRICT,

  CONSTRAINT media_artifacts_identifier_check CHECK (
    artifact_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND batch_project_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND video_task_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND created_by ~ '^[A-Za-z0-9_-]{1,128}$'
    AND storage_provider_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND creation_actor_account_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND creation_request_id ~ '^[A-Za-z0-9_-]{1,128}$'
  ),
  CONSTRAINT media_artifacts_stage_role_check CHECK (
    (stage = 'video_preview' AND role = 'preview')
    OR (stage = 'delivery' AND role = 'delivery')
  ),
  CONSTRAINT media_artifacts_version_size_check CHECK (
    artifact_version BETWEEN 1 AND 9007199254740991
    AND byte_size BETWEEN 1 AND 9007199254740991
    AND width BETWEEN 1 AND 32768
    AND height BETWEEN 1 AND 32768
    AND duration_ms BETWEEN 1 AND 9007199254740991
  ),
  CONSTRAINT media_artifacts_hash_check CHECK (
    checksum_sha256 ~ '^[0-9a-f]{64}$'
    AND creation_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT media_artifacts_media_type_check CHECK (
    media_type IN ('video/mp4', 'video/webm')
  ),
  CONSTRAINT media_artifacts_bucket_check CHECK (
    length(storage_bucket_name) BETWEEN 3 AND 255
    AND storage_bucket_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$'
  ),
  CONSTRAINT media_artifacts_object_key_check CHECK (
    octet_length(storage_object_key) BETWEEN 1 AND 1024
    AND storage_object_key ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    AND right(storage_object_key, 1) <> '/'
    AND storage_object_key NOT LIKE '%//%'
    AND storage_object_key = concat(
      'v1/tenants/', tenant_id,
      '/projects/', batch_project_id,
      '/tasks/', video_task_id,
      '/artifacts/', artifact_id,
      '/media'
    )
    AND NOT (
      string_to_array(storage_object_key, '/')
      && ARRAY['.', '..']::text[]
    )
  ),
  CONSTRAINT media_artifacts_object_version_check CHECK (
    storage_object_version IS NULL
    OR (
      length(storage_object_version) BETWEEN 1 AND 1024
      AND storage_object_version ~ '^[A-Za-z0-9+_.=/~-]+$'
    )
  ),
  CONSTRAINT media_artifacts_creation_actor_check CHECK (
    created_by = creation_actor_account_id
  ),
  CONSTRAINT media_artifacts_envelope_check CHECK (
    (jsonb_typeof(artifact) = 'object') IS TRUE
    AND artifact ?& ARRAY[
      'schemaVersion', 'id', 'tenantId', 'batchProjectId', 'videoTaskId',
      'stage', 'role', 'version', 'mediaType', 'byteSize', 'checksumSha256',
      'width', 'height', 'durationMs', 'createdAt', 'createdBy'
    ]
    AND artifact - ARRAY[
      'schemaVersion', 'id', 'tenantId', 'batchProjectId', 'videoTaskId',
      'stage', 'role', 'version', 'mediaType', 'byteSize', 'checksumSha256',
      'width', 'height', 'durationMs', 'createdAt', 'createdBy'
    ] = '{}'::jsonb
    AND (artifact ->> 'schemaVersion' = '1') IS TRUE
    AND (artifact ->> 'id' = artifact_id) IS TRUE
    AND (artifact ->> 'tenantId' = tenant_id) IS TRUE
    AND (artifact ->> 'batchProjectId' = batch_project_id) IS TRUE
    AND (artifact ->> 'videoTaskId' = video_task_id) IS TRUE
    AND (artifact ->> 'stage' = stage) IS TRUE
    AND (artifact ->> 'role' = role) IS TRUE
    AND ((artifact ->> 'version')::bigint = artifact_version) IS TRUE
    AND (artifact ->> 'mediaType' = media_type) IS TRUE
    AND ((artifact ->> 'byteSize')::bigint = byte_size) IS TRUE
    AND (artifact ->> 'checksumSha256' = checksum_sha256) IS TRUE
    AND ((artifact ->> 'width')::integer = width) IS TRUE
    AND ((artifact ->> 'height')::integer = height) IS TRUE
    AND ((artifact ->> 'durationMs')::bigint = duration_ms) IS TRUE
    AND ((artifact ->> 'createdAt')::timestamptz = created_at) IS TRUE
    AND (artifact ->> 'createdBy' = created_by) IS TRUE
  )
);

CREATE INDEX media_artifacts_task_list_idx
  ON media_artifacts (
    tenant_id,
    batch_project_id,
    video_task_id,
    stage,
    role,
    artifact_version,
    artifact_id
  );
