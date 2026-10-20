import type { RmmAgentStatus, RmmProvider, RmmStorageInfo } from '@alga-psa/types';

export type NormalizedRmmScopeKind = 'organization' | 'site' | 'group' | 'custom';

export interface NormalizedRmmExternalScopeSnapshot {
  provider: RmmProvider;
  externalScopeId: string;
  externalScopeName: string;
  parentExternalScopeId?: string | null;
  kind: NormalizedRmmScopeKind;
  metadata?: Record<string, unknown>;
}

export type NormalizedRmmDeviceType = 'workstation' | 'server' | 'network_device' | 'mobile_device' | 'unknown';
export type NormalizedRmmDeviceLifecycleState = 'active' | 'offline' | 'deleted' | 'tombstoned';

export interface NormalizedRmmDeviceExtensionSnapshot {
  osType?: string | null;
  osVersion?: string | null;
  agentVersion?: string | null;
  currentUser?: string | null;
  uptimeSeconds?: number | null;
  lanIp?: string | null;
  wanIp?: string | null;
  antivirusStatus?: string | null;
  antivirusProduct?: string | null;
  lastRebootAt?: string | null;
  pendingPatches?: number | null;
  pendingOsPatches?: number | null;
  pendingSoftwarePatches?: number | null;
  failedPatches?: number | null;
  lastPatchScanAt?: string | null;
  /** Hardware make, written to assets.manufacturer (FR-A3). */
  manufacturer?: string | null;
  /** Hardware model, written to assets.model (FR-A3). */
  model?: string | null;
  cpuModel?: string | null;
  cpuCores?: number | null;
  ramGb?: number | null;
  diskUsage?: RmmStorageInfo[] | null;
  installedSoftware?: unknown[] | null;
  systemInfo?: Record<string, unknown> | null;
}

export interface NormalizedRmmExternalDeviceSnapshot {
  provider: RmmProvider;
  integrationId: string;
  externalDeviceId: string;
  externalScopeId: string;
  lifecycleState: NormalizedRmmDeviceLifecycleState;
  assetType: NormalizedRmmDeviceType;
  displayName: string;
  serialNumber?: string | null;
  status?: string | null;
  location?: string | null;
  assetTag?: string | null;
  agentStatus?: RmmAgentStatus | null;
  lastSeenAt?: string | null;
  /**
   * MAC addresses the provider reported for the device this run, in any common
   * notation. Feeds cross-RMM deduplication (see assetDeduplication.ts).
   * Undefined means "not read this run" and leaves the recorded set alone; an
   * empty array means the device reported none.
   */
  macAddresses?: string[];
  extension?: NormalizedRmmDeviceExtensionSnapshot;
  metadata?: Record<string, unknown>;
}

export interface NormalizedRmmIngestionResult {
  externalDeviceId: string;
  /**
   * 'linked': the device was new to this provider and was attached to an
   * existing asset another RMM already created for the same machine.
   */
  action: 'created' | 'updated' | 'linked' | 'marked_deleted' | 'skipped' | 'failed';
  assetId?: string;
  error?: string;
  /**
   * 'secondary' when the asset belongs to another, still-mapped RMM: only this
   * provider's mapping and MACs were written, not the asset itself.
   */
  ownership?: 'primary' | 'secondary';
}
