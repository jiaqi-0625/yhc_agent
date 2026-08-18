export async function api(path, options) {
  const response = await fetch(path, options);
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
