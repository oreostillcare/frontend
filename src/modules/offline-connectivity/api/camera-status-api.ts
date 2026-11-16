import { apiGet } from "./backend-api-client";

// Typed camera-status endpoints used by monitoring and telemetry polling.
import type { CameraStatus } from "./telemetry-api-types";
export const getCameras = () => apiGet<CameraStatus[]>("/api/cameras");
export const getCamera = (id: number) => apiGet<CameraStatus>(`/api/cameras/${id}`);
