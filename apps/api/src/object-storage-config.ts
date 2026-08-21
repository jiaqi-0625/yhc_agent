export type ObjectStorageBackend = "disabled" | "s3";

export interface DisabledObjectStorageConfig {
  readonly backend: "disabled";
}

export interface S3StaticCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3ObjectStorageConfig {
  readonly backend: "s3";
  readonly region: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly signedGetTtlSeconds: number;
  readonly credentials?: S3StaticCredentials;
}

export type ObjectStorageConfig = DisabledObjectStorageConfig | S3ObjectStorageConfig;

export class ObjectStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageConfigError";
  }
}

type ObjectStorageEnvironment = Readonly<Record<string, string | undefined>>;

const endpointSetting = "OBJECT_STORAGE_S3_ENDPOINT";

function requiredSetting(
  environment: ObjectStorageEnvironment,
  key: string,
  label: string,
): string {
  const value = environment[key];
  if (value === undefined || value.length === 0) {
    throw new ObjectStorageConfigError(`${label} is required when object storage is enabled.`);
  }
  if (value !== value.trim()) {
    throw new ObjectStorageConfigError(`${label} must not contain surrounding whitespace.`);
  }
  return value;
}

function parseBackend(environment: ObjectStorageEnvironment): ObjectStorageBackend {
  const value = environment.OBJECT_STORAGE_BACKEND ?? "disabled";
  if (value !== "disabled" && value !== "s3") {
    throw new ObjectStorageConfigError(
      "OBJECT_STORAGE_BACKEND must be one of disabled or s3.",
    );
  }
  return value;
}

function parseRegion(environment: ObjectStorageEnvironment): string {
  const region = requiredSetting(environment, "OBJECT_STORAGE_S3_REGION", "S3 region");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(region)) {
    throw new ObjectStorageConfigError("S3 region has an invalid format.");
  }
  return region;
}

function parseBucket(environment: ObjectStorageEnvironment): string {
  const bucket = requiredSetting(environment, "OBJECT_STORAGE_S3_BUCKET", "S3 bucket");
  const labels = bucket.split(".");
  const isIpv4Address = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(bucket);
  const validLabels = labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
  );
  if (bucket.length < 3 || bucket.length > 63 || isIpv4Address || !validLabels) {
    throw new ObjectStorageConfigError("S3 bucket has an invalid format.");
  }
  return bucket;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return true;
  }
  const ipv4Match = /^127(?:\.[0-9]{1,3}){3}$/u.exec(normalized);
  if (ipv4Match === null) {
    return false;
  }
  return normalized
    .split(".")
    .every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function parseEndpoint(environment: ObjectStorageEnvironment): string | undefined {
  const value = environment[endpointSetting];
  if (value === undefined) {
    return undefined;
  }
  if (value.length === 0 || value !== value.trim()) {
    throw new ObjectStorageConfigError("S3 endpoint must be a valid absolute URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ObjectStorageConfigError("S3 endpoint must be a valid absolute URL.");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.hostname.length === 0
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.pathname !== "/"
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new ObjectStorageConfigError("S3 endpoint must be an origin-only HTTP(S) URL.");
  }
  if (parsed.protocol === "http:") {
    if (environment.NODE_ENV === "production") {
      throw new ObjectStorageConfigError("Production S3 endpoints must use HTTPS.");
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new ObjectStorageConfigError(
        "Development HTTP S3 endpoints must use a loopback hostname.",
      );
    }
  }
  return parsed.origin;
}

function parseBoolean(environment: ObjectStorageEnvironment, key: string): boolean {
  const value = environment[key];
  if (value === undefined) {
    return false;
  }
  if (value !== "true" && value !== "false") {
    throw new ObjectStorageConfigError(`${key} must be true or false.`);
  }
  return value === "true";
}

function parseSignedGetTtl(environment: ObjectStorageEnvironment): number {
  const value = environment.OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS;
  if (value === undefined) {
    return 300;
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ObjectStorageConfigError(
      "OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS must be a base-10 integer.",
    );
  }
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900) {
    throw new ObjectStorageConfigError(
      "OBJECT_STORAGE_SIGNED_GET_TTL_SECONDS must be between 60 and 900.",
    );
  }
  return ttl;
}

function parseCredentials(
  environment: ObjectStorageEnvironment,
): S3StaticCredentials | undefined {
  const accessKeyId = environment.OBJECT_STORAGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = environment.OBJECT_STORAGE_S3_SECRET_ACCESS_KEY;
  const sessionToken = environment.OBJECT_STORAGE_S3_SESSION_TOKEN;
  const hasAccessKeyId = accessKeyId !== undefined;
  const hasSecretAccessKey = secretAccessKey !== undefined;

  if (hasAccessKeyId !== hasSecretAccessKey) {
    throw new ObjectStorageConfigError(
      "Static S3 access key ID and secret access key must be configured together.",
    );
  }
  if (!hasAccessKeyId || accessKeyId === undefined || secretAccessKey === undefined) {
    if (sessionToken !== undefined) {
      throw new ObjectStorageConfigError(
        "An S3 session token requires the static access key pair.",
      );
    }
    return undefined;
  }
  if (
    accessKeyId.length === 0
    || secretAccessKey.length === 0
    || accessKeyId !== accessKeyId.trim()
    || secretAccessKey !== secretAccessKey.trim()
    || (sessionToken !== undefined && (
      sessionToken.length === 0 || sessionToken !== sessionToken.trim()
    ))
  ) {
    throw new ObjectStorageConfigError("Static S3 credentials are invalid.");
  }

  const credentials: S3StaticCredentials = sessionToken === undefined
    ? { accessKeyId, secretAccessKey }
    : { accessKeyId, secretAccessKey, sessionToken };
  return Object.freeze(credentials);
}

export function parseObjectStorageConfig(
  environment: ObjectStorageEnvironment = process.env,
): ObjectStorageConfig {
  if (parseBackend(environment) === "disabled") {
    return Object.freeze({ backend: "disabled" });
  }

  const endpoint = parseEndpoint(environment);
  const credentials = parseCredentials(environment);
  const config: S3ObjectStorageConfig = {
    backend: "s3",
    region: parseRegion(environment),
    bucket: parseBucket(environment),
    forcePathStyle: parseBoolean(environment, "OBJECT_STORAGE_S3_FORCE_PATH_STYLE"),
    signedGetTtlSeconds: parseSignedGetTtl(environment),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(credentials === undefined ? {} : { credentials }),
  };
  return Object.freeze(config);
}
