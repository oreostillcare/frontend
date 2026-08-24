import { apiGet } from "./client";
import type { CameraStatus } from "./types";
export const getCameras = () => apiGet<CameraStatus[]>("/api/cameras");
export const getCamera = (id: number) => apiGet<CameraStatus>(`/api/cameras/${id}`);
