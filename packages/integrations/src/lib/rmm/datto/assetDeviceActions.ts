import axios from 'axios';

import { createTenantKnex } from '@alga-psa/db';

import type { RmmAssetDeviceActions, RmmAssetDeviceRef, RmmRemoteConnectionType } from '../assetDeviceActions';
import { buildDattoClientForTenant, getDattoIntegrationRow } from './buildClient';
import { DattoRmmAuthError, DattoRmmPermissionError, type DattoRmmClient } from './dattoApiClient';
import type { DattoRmmIntegrationSettingsJson } from './shared';
import { syncDattoSingleDeviceForTenant } from './syncSingleDevice';

/**
 * Turns Datto client failures into messages that are safe to show in the UI.
 * Axios errors are never passed through verbatim so request details (and the
 * bearer token in them) cannot reach the user.
 */
function dattoActionError(err: unknown, fallback: string): Error {
  if (err instanceof DattoRmmPermissionError) {
    return new Error('The Datto RMM API user lacks permission for this action.');
  }
  if (err instanceof DattoRmmAuthError) {
    return new Error('Datto RMM rejected the stored credentials. Reconnect the integration in settings.');
  }
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 404) return new Error('Datto RMM no longer knows this device.');
    if (status === 409 || status === 400) {
      return new Error('Datto RMM could not run this action. The device may be offline.');
    }
    return new Error(fallback);
  }
  return err instanceof Error && err.message ? err : new Error(fallback);
}

async function requireClient(tenant: string): Promise<DattoRmmClient> {
  const client = await buildDattoClientForTenant(tenant);
  if (!client) throw new Error('No active Datto RMM integration found');
  return client;
}

async function readRebootComponentUid(tenant: string): Promise<string | null> {
  const { knex } = await createTenantKnex();
  const row = await getDattoIntegrationRow(knex, tenant);
  const settings = (row?.settings ?? {}) as DattoRmmIntegrationSettingsJson;
  const uid = typeof settings.rebootComponentUid === 'string' ? settings.rebootComponentUid.trim() : '';
  return uid || null;
}

async function currentWebRemoteUrl(ref: RmmAssetDeviceRef, client: DattoRmmClient): Promise<string | null> {
  const device = await client.getDevice(ref.deviceId);
  const url = typeof device?.webRemoteUrl === 'string' ? device.webRemoteUrl.trim() : '';
  return url || null;
}

export const dattoRmmAssetDeviceActions: RmmAssetDeviceActions = {
  async refresh(ref: RmmAssetDeviceRef): Promise<void> {
    let result;
    try {
      result = await syncDattoSingleDeviceForTenant({ tenant: ref.tenant, deviceUid: ref.deviceId });
    } catch (err) {
      throw dattoActionError(err, 'Datto RMM could not refresh this device.');
    }
    if (!result.updated) {
      throw new Error('Asset is not mapped to a Datto RMM device');
    }
  },

  // Datto's Web Remote is a browser session; it reuses the 'splashtop' slot the
  // asset UI labels "Remote Desktop", the same as Tactical's MeshCentral control.
  async remoteControlTypes(ref): Promise<RmmRemoteConnectionType[]> {
    const client = await buildDattoClientForTenant(ref.tenant);
    if (!client) return [];
    try {
      return (await currentWebRemoteUrl(ref, client)) ? ['splashtop'] : [];
    } catch {
      // The button simply does not render when the device cannot be read.
      return [];
    }
  },

  async remoteControlUrl(ref, connectionType) {
    if (connectionType !== 'splashtop') return null;
    const client = await requireClient(ref.tenant);
    try {
      // Fresh read: the stored URL can be stale after a device reinstall.
      return await currentWebRemoteUrl(ref, client);
    } catch (err) {
      throw dattoActionError(err, 'Datto RMM could not open a Web Remote session.');
    }
  },

  async reboot(ref: RmmAssetDeviceRef): Promise<void> {
    const componentUid = await readRebootComponentUid(ref.tenant);
    if (!componentUid) {
      throw new Error('Configure a reboot component in Datto RMM settings before rebooting from Alga.');
    }
    const client = await requireClient(ref.tenant);
    try {
      await client.createQuickJob(ref.deviceId, {
        jobName: `Alga PSA reboot — ${ref.assetName}`,
        componentUid,
      });
    } catch (err) {
      throw dattoActionError(err, 'Datto RMM could not send the reboot job.');
    }
  },

  async runScript(ref: RmmAssetDeviceRef, componentUid: string): Promise<{ jobId?: string }> {
    const client = await requireClient(ref.tenant);
    try {
      const created = await client.createQuickJob(ref.deviceId, {
        jobName: `Alga PSA — ${ref.assetName}`,
        componentUid,
      });
      return { jobId: created?.job?.uid };
    } catch (err) {
      throw dattoActionError(err, 'Datto RMM could not run the component.');
    }
  },
};
