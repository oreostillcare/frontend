const DETECTION_PROXY_PATH = "/detection";

export class ApiError extends Error {}

export async function apiGet<T>(path: string, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DETECTION_PROXY_PATH}${path}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new ApiError(`Backend returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError("Detection backend is unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export function videoUrl(cameraId: number) {
  return `${DETECTION_PROXY_PATH}/video/camera/${cameraId}`;
}
