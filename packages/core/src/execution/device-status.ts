/**
 * Device status — the laptop runtime's live availability, as the agent's
 * per-turn context must see it.
 *
 * The user-level device hub (UserDO on CF) is the single source of truth for
 * whether the user's PC is reachable. These helpers reduce a hub snapshot to
 * the three-state presence the prompt cares about and render the one-turn
 * change notice for mid-session connect/disconnect transitions. Backends diff
 * `devicePresence` against the last presence they observed (a watermark, not
 * a second source of truth) at turn start — no polling between turns.
 */

/** Hub snapshot of the user's device fleet, from the transport's perspective. */
export interface DeviceStatus {
  /** A live daemon socket is open on the user's device hub right now. */
  connected: boolean;
  /** The user has at least one registered (non-revoked) device. */
  registered: boolean;
}

/** What the turn context says about the user's PC. */
export type DevicePresence = 'connected' | 'offline' | 'none';

/** Config key under which backends persist the last presence they observed. */
export const DEVICE_PRESENCE_CONFIG_KEY = 'device_last_presence';

export function devicePresence(status: DeviceStatus): DevicePresence {
  if (status.connected) return 'connected';
  return status.registered ? 'offline' : 'none';
}

/** Parse a persisted watermark. Unknown/missing values mean "never observed". */
export function parseDevicePresence(value: string | null | undefined): DevicePresence | null {
  return value === 'connected' || value === 'offline' || value === 'none' ? value : null;
}

/**
 * The clearly-marked context block injected at the latest position of the
 * next turn when device availability changed mid-session. Null when nothing
 * changed, on the first observation (nothing to diff against), or for
 * transitions that don't change what the agent can reach (offline ↔ none).
 */
export function deviceChangeNotice(prev: DevicePresence | null, current: DevicePresence): string | null {
  if (prev === null || prev === current) return null;
  if (current === 'connected') {
    return '## Context update\n' +
      "Your user's PC just connected — the `laptop` runtime is now available. " +
      'Consent will be requested on its first use; that prompt is expected, not an error.';
  }
  if (prev === 'connected') {
    return '## Context update\n' +
      "Your user's PC just disconnected — the `laptop` runtime is offline" +
      (current === 'offline'
        ? '. The user can reconnect it by running `proteus connect` on their machine.'
        : ' and the device is no longer registered.');
  }
  return null;
}
