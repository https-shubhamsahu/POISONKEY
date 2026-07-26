// Freighter wallet, with every state the UI has to show made explicit.
import { NETWORK_PASSPHRASE } from './chain';

export type WalletState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'missing' }
  | { status: 'wrong-network'; address: string; network: string }
  | { status: 'connected'; address: string }
  | { status: 'error'; message: string };

type MaybeError = { error?: unknown };

function errText(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'message' in (v as Record<string, unknown>)) {
    return String((v as { message: unknown }).message);
  }
  return String(v);
}

export async function connect(): Promise<WalletState> {
  let api: typeof import('@stellar/freighter-api');
  try {
    api = await import('@stellar/freighter-api');
  } catch {
    return { status: 'missing' };
  }

  const connected = await api.isConnected();
  const present =
    typeof connected === 'boolean' ? connected : Boolean((connected as { isConnected?: boolean })?.isConnected);
  if (!present) return { status: 'missing' };

  const access = (await api.requestAccess()) as MaybeError & { address?: string };
  const accessErr = errText(access?.error);
  if (accessErr) {
    return /not allowed|declined|denied/i.test(accessErr)
      ? { status: 'disconnected' }
      : { status: 'error', message: accessErr };
  }

  const addr = (await api.getAddress()) as MaybeError & { address?: string };
  const addrErr = errText(addr?.error);
  if (addrErr) return { status: 'error', message: addrErr };
  const address = typeof addr === 'string' ? addr : (addr.address ?? access.address ?? '');
  if (!address) return { status: 'error', message: 'Freighter did not return an address.' };

  const net = (await api.getNetwork()) as MaybeError & {
    network?: string;
    networkPassphrase?: string;
  };
  const netErr = errText(net?.error);
  if (netErr) return { status: 'error', message: netErr };
  if (net.networkPassphrase !== NETWORK_PASSPHRASE) {
    return { status: 'wrong-network', address, network: net.network ?? 'unknown' };
  }

  return { status: 'connected', address };
}

/** Poll the wallet so switching account or network in the extension is noticed. */
export async function refreshWallet(current: WalletState): Promise<WalletState | null> {
  if (current.status !== 'connected' && current.status !== 'wrong-network') return null;
  try {
    const api = await import('@stellar/freighter-api');
    const net = (await api.getNetwork()) as { networkPassphrase?: string; network?: string };
    const addr = (await api.getAddress()) as { address?: string };
    const address = addr?.address ?? ('address' in current ? current.address : '');
    if (!address) return { status: 'disconnected' };
    if (net?.networkPassphrase !== NETWORK_PASSPHRASE) {
      return { status: 'wrong-network', address, network: net?.network ?? 'unknown' };
    }
    return { status: 'connected', address };
  } catch {
    return null;
  }
}

export const FREIGHTER_URL = 'https://www.freighter.app/';
