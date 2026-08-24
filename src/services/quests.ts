/**
 * Quests — client for the Coldstar quest board API (coldstar.dev/api/quests).
 *
 * The board itself is served by Cloudflare Pages Functions backed by D1, the
 * same API the web board at coldstar.dev/quests uses. This app is a second
 * front-end over it, not a second implementation — points, campaigns and the
 * completion bonus all live server-side.
 *
 * Signing note: this is an air-gapped wallet, so there is no injected provider
 * with a `signMessage` method. Proving wallet ownership goes through
 * getKeypair(pin), which decrypts the keypair only for the duration of the
 * signature. Nothing is broadcast and no transaction is built.
 */
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { getKeypair } from './wallet';

const API = 'https://coldstar.dev/api/quests';

export interface QuestStep {
  id: string;
  title: string;
  description: string | null;
  points: number;
  verifyKind: string;
  actionUrl: string | null;
  icon: string | null;
  iconUrl: string | null;
  done: boolean;
  completedAt: string | null;
}

export interface QuestCampaign {
  id: string;
  title: string;
  subtitle: string | null;
  bonusPoints: number;
  sponsor: string | null;
  bannerUrl: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  stepPoints: number;
  stepsDone: number;
  stepsTotal: number;
  complete: boolean;
  bonusEarned: boolean;
  steps: QuestStep[];
}

export interface QuestBoard {
  ok: boolean;
  wallet: string | null;
  refCode: string | null;
  points: number;
  totalAvailable: number;
  campaigns: QuestCampaign[];
}

export interface ClaimResult {
  ok: boolean;
  already?: boolean;
  awarded?: number;
  bonusAwarded?: number;
  campaignComplete?: boolean;
  campaignId?: string;
  points?: number;
  error?: string;
  unavailable?: boolean;
}

export async function fetchBoard(wallet: string | null, ref?: string): Promise<QuestBoard> {
  const qs = new URLSearchParams();
  if (wallet) qs.set('wallet', wallet);
  if (ref) qs.set('ref', ref);
  const r = await fetch(`${API}${qs.toString() ? '?' + qs.toString() : ''}`);
  return (await r.json()) as QuestBoard;
}

export interface LeaderRow {
  rank: number;
  wallet: string;
  points: number;
  isYou?: boolean;
}

export async function fetchLeaderboard(
  wallet: string | null,
  limit = 25
): Promise<{ ok: boolean; leaders: LeaderRow[]; me: LeaderRow | null }> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (wallet) qs.set('wallet', wallet);
  const r = await fetch(`${API}/leaderboard?${qs.toString()}`);
  return await r.json();
}

/**
 * Claim one step. Requires the wallet PIN because proving ownership means
 * producing a real ed25519 signature over the server's challenge string.
 *
 * The challenge is fetched from the server rather than composed here so the
 * signed bytes can never drift from what the verifier reconstructs.
 */
export async function claimStep(wallet: string, stepId: string, pin: string, ref?: string): Promise<ClaimResult> {
  const cr = await fetch(`${API}/challenge?wallet=${encodeURIComponent(wallet)}&step=${encodeURIComponent(stepId)}`);
  const challenge = await cr.json();
  if (!challenge.ok) return { ok: false, error: challenge.error || 'Could not start verification' };

  let signature: string;
  try {
    const kp = await getKeypair(pin);
    // Solana secretKey is 64 bytes (32-byte seed || 32-byte pubkey); noble
    // signs from the seed half.
    const seed = kp.secretKey.slice(0, 32);
    const msg = new TextEncoder().encode(challenge.message);
    signature = bs58.encode(ed25519.sign(msg, seed));
  } catch (e: any) {
    return { ok: false, error: e?.message === 'Invalid PIN' ? 'Incorrect PIN' : 'Could not sign — check your PIN' };
  }

  const r = await fetch(`${API}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet, stepId, issuedAt: challenge.issuedAt, signature, ref: ref || '' }),
  });
  return (await r.json()) as ClaimResult;
}
