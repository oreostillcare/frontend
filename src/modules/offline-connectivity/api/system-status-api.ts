import { apiGet } from "./backend-api-client";
// Typed system and model status endpoints used by dashboard telemetry.
import type { ModelStatus, SystemStatus } from "./telemetry-api-types";
export const getSystemStatus = () => apiGet<SystemStatus>("/api/system/status");
export const getModelStatus = () => apiGet<ModelStatus>("/api/model");
