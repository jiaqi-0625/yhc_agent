CREATE TABLE video_generation_requests (
  generation_request_id varchar(128) NOT NULL,
  tenant_id varchar(128) NOT NULL,
  batch_project_id varchar(128) NOT NULL,
  video_task_id varchar(128) NOT NULL,
  actor_account_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  task_revision bigint NOT NULL,
  vehicle_snapshot_id varchar(128) NOT NULL,
  asset_snapshot_id varchar(128) NOT NULL,
  storyboard_artifact_version_id varchar(128) NOT NULL,
  provider_id varchar(128) NOT NULL,
  provider_job_id varchar(256),
  provider_status varchar(32) NOT NULL,
  outcome_status varchar(16) NOT NULL,
  model_id varchar(256) NOT NULL,
  resolution varchar(16) NOT NULL,
  aspect_ratio varchar(16) NOT NULL,
  duration_seconds integer NOT NULL,
  prompt_text text NOT NULL,
  prompt_sha256 char(64) NOT NULL,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  charged_amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  media_artifact_id varchar(128),
  failure_code varchar(200),

  CONSTRAINT video_generation_requests_pkey
    PRIMARY KEY (generation_request_id),
  CONSTRAINT video_generation_requests_actor_request_key
    UNIQUE (
      tenant_id,
      batch_project_id,
      video_task_id,
      actor_account_id,
      request_id
    ),
  CONSTRAINT video_generation_requests_task_fkey
    FOREIGN KEY (tenant_id, batch_project_id, video_task_id)
    REFERENCES video_task_aggregates (tenant_id, project_id, task_id)
    ON DELETE RESTRICT,
  CONSTRAINT video_generation_requests_media_fkey
    FOREIGN KEY (media_artifact_id)
    REFERENCES media_artifacts (artifact_id)
    ON DELETE RESTRICT,

  CONSTRAINT video_generation_requests_identifier_check CHECK (
    generation_request_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND tenant_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND batch_project_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND video_task_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND actor_account_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND request_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND vehicle_snapshot_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND asset_snapshot_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND storyboard_artifact_version_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND provider_id ~ '^[A-Za-z0-9_-]{1,128}$'
    AND (provider_job_id IS NULL OR provider_job_id ~ '^[A-Za-z0-9_-]{1,256}$')
    AND (media_artifact_id IS NULL OR media_artifact_id ~ '^[A-Za-z0-9_-]{1,128}$')
  ),
  CONSTRAINT video_generation_requests_values_check CHECK (
    task_revision BETWEEN 0 AND 9007199254740991
    AND length(btrim(model_id)) BETWEEN 1 AND 256
    AND resolution IN ('480p', '720p', '1080p')
    AND aspect_ratio IN ('16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive')
    AND duration_seconds BETWEEN 1 AND 3600
    AND length(btrim(prompt_text)) BETWEEN 1 AND 20000
    AND prompt_sha256 ~ '^[0-9a-f]{64}$'
    AND completed_at >= requested_at
    AND charged_amount_minor BETWEEN 0 AND 9007199254740991
    AND currency = 'CNY'
  ),
  CONSTRAINT video_generation_requests_status_check CHECK (
    provider_status IN (
      'request_failed', 'queued', 'running', 'succeeded', 'failed', 'cancelled'
    )
    AND outcome_status IN ('succeeded', 'failed')
    AND (
      (
        outcome_status = 'succeeded'
        AND provider_status = 'succeeded'
        AND provider_job_id IS NOT NULL
        AND media_artifact_id IS NOT NULL
        AND charged_amount_minor > 0
        AND failure_code IS NULL
      )
      OR (
        outcome_status = 'failed'
        AND charged_amount_minor = 0
        AND failure_code IS NOT NULL
        AND length(btrim(failure_code)) BETWEEN 1 AND 200
      )
    )
  )
);

CREATE UNIQUE INDEX video_generation_requests_task_time_idx
  ON video_generation_requests (
    tenant_id,
    batch_project_id,
    video_task_id,
    requested_at,
    generation_request_id
  );

CREATE FUNCTION reject_video_generation_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'video generation request history is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER video_generation_requests_reject_update
BEFORE UPDATE ON video_generation_requests
FOR EACH ROW EXECUTE FUNCTION reject_video_generation_request_mutation();

CREATE TRIGGER video_generation_requests_reject_delete
BEFORE DELETE ON video_generation_requests
FOR EACH ROW EXECUTE FUNCTION reject_video_generation_request_mutation();
