const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || "").replace(/\/$/, "");

export class ApiError extends Error {}

export async function apiGet<T>(path: string, timeoutMs = 4000): Promise<T> {
  if (!BACKEND_URL) throw new ApiError("Backend URL is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BACKEND_URL}${path}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new ApiError(`Backend returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError("Detection backend is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function videoUrl(cameraId: number) {
  return BACKEND_URL ? `${BACKEND_URL}/video/camera/${cameraId}` : "";
}
