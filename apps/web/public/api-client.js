let workspaceSessionToken = null;

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload && typeof payload.message === "string"
      ? payload.message
      : "请求失败（HTTP " + status + "）");
    this.name = "ApiError";
    this.code = payload && typeof payload.code === "string"
      ? payload.code
      : "AIC-API-REQUEST_FAILED";
    this.status = status;
    this.requestId = payload && typeof payload.requestId === "string" ? payload.requestId : undefined;
    this.retryable = Boolean(payload && payload.retryable);
    this.charged = Boolean(payload && payload.charged);
  }
}

export function setWorkspaceSessionToken(token) {
  workspaceSessionToken = typeof token === "string" && token ? token : null;
}

export function authenticatedFetch(path, options) {
  if (typeof path !== "string" || !/^\/v1(?:\/|\?|$)/u.test(path)) {
    throw new TypeError("只允许访问当前服务的内部 API。");
  }
  const headers = new Headers(options?.headers);
  if (workspaceSessionToken) headers.set("authorization", "Bearer " + workspaceSessionToken);
  else headers.delete("authorization");
  return fetch(path, { ...options, headers });
}

export async function api(path, options) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch {}
    throw new ApiError(payload, response.status);
  }
  if (response.status === 204) return null;
  return response.json();
}

export async function authenticatedBlob(path, options) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch {}
    throw new ApiError(payload, response.status);
  }
  return response.blob();
}
