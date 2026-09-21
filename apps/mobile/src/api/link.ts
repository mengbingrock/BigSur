// Device Link (relay) endpoints on the box: which Macs are linked to this
// account, device pairing, and push registration.
import { apiGet, apiSend, type Target } from "./client";

export interface HostInfo {
  hostId: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
}
export interface DeviceInfo {
  id: string;
  name: string;
  platform: string | null;
  status: "pending" | "approved" | "revoked";
  code: string | null;
  createdAt: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
}

export const listHosts = (t: Target) => apiGet<{ hosts: HostInfo[] }>(t, "/api/link/hosts");
export const listDevices = (t: Target) => apiGet<{ devices: DeviceInfo[] }>(t, "/api/link/devices");
export const requestPairing = (t: Target, body: { name: string; platform: string }) =>
  apiSend<{ device: DeviceInfo; token: string }>(t, "POST", "/api/link/devices", body);
export const revokeDevice = (t: Target, id: string) => apiSend<{ ok: true }>(t, "DELETE", `/api/link/devices/${id}`);
export const registerPushToken = (t: Target, pushToken: string) =>
  apiSend<{ ok: true }>(t, "POST", "/api/link/push-token", { pushToken });
export const pendingApprovals = (t: Target) => apiGet<{ devices: DeviceInfo[] }>(t, "/api/link/pending");
export const approveDevice = (t: Target, id: string, approve: boolean) =>
  apiSend<{ ok: true }>(t, "POST", `/api/link/pending/${id}/${approve ? "approve" : "reject"}`);
