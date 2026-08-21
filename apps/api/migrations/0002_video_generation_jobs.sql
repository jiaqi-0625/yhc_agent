CREATE TABLE video_generation_jobs (
  job_id varchar(128) PRIMARY KEY,
  tenant_id varchar(128) NOT NULL,
  project_id varchar(128) NOT NULL,
  video_task_id varchar(128) NOT NULL,
  actor_account_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  provider_job_id varchar(128) NOT NULL,
  status varchar(32) NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 1),
  state jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT video_generation_jobs_request_key UNIQUE (tenant_id, actor_account_id, request_id),
  CONSTRAINT video_generation_jobs_task_fkey FOREIGN KEY (tenant_id, project_id, video_task_id)
    REFERENCES video_task_aggregates (tenant_id, project_id, task_id),
  CONSTRAINT video_generation_jobs_status_check CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  )
);

CREATE INDEX video_generation_jobs_task_idx
  ON video_generation_jobs (tenant_id, project_id, video_task_id, created_at DESC);
