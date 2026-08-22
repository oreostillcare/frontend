import { apiGet } from "./client";
import type { ModelStatus, SystemStatus } from "./types";
export const getSystemStatus = () => apiGet<SystemStatus>("/api/system/status");
export const getModelStatus = () => apiGet<ModelStatus>("/api/model");
