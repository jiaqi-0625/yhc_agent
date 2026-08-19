let workspaceSessionToken = null;

export function setWorkspaceSessionToken(token) {
  workspaceSessionToken = typeof token === "string" && token ? token : null;
}

export async function api(path, options) {
  const headers = new Headers(options?.headers);
  if (workspaceSessionToken) headers.set("authorization", "Bearer " + workspaceSessionToken);
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = "请求失败（HTTP " + response.status + "）";
    try {
      const body = await response.json();
      if (body && typeof body.message === "string") message = body.message;
    } catch {}
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}
