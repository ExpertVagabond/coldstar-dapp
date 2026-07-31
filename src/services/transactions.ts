/**
 * Transaction Service — Build and submit real Solana transactions
 */
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,

} from '@solana/spl-token';
import { getConnection, getLatestBlockhash } from './solana';

/** Service fee configuration */
export const SERVICE_FEE_RATE = 0.01; // 1%
export const SERVICE_FEE_ADDRESS = 'Cak1aAwxM2jTdu7AtdaHbqAc3Dfafts7KdsHNrtXN5rT';

/**
 * Poll getSignatureStatuses until the transaction is confirmed or timeout.
 * This avoids the unreliable WebSocket-based confirmTransaction on devnet.
 */
async function pollForConfirmation(
  conn: Connection,
  signature: string,
  timeoutMs: number = 30000,
  intervalMs: number = 1500
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const status = value?.[0];
    if (status) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  // Last check before giving up
  const { value } = await conn.getSignatureStatuses([signature]);
  const status = value?.[0];
  if (status && !status.err) return;
  throw new Error('Transaction confirmation timed out — check explorer, it may have succeeded');
}

export interface TransferParams {
  from: Keypair;
  to: string;
  amount: number; // In human-readable units (e.g., 1.5 SOL)
  mint?: string;  // If undefined, send SOL. Otherwise SPL token mint
  decimals?: number;
}

export interface TransactionResult {
  signature: string;
  success: boolean;
  error?: string;
}

/**
 * Send SOL to a recipient
 */
export async function sendSol(params: TransferParams): Promise<TransactionResult> {
  const conn = getConnection();
  const toKey = new PublicKey(params.to);
  const lamports = Math.round(params.amount * LAMPORTS_PER_SOL);
  const feeLamports = Math.round(lamports * SERVICE_FEE_RATE);
  const feeRecipient = new PublicKey(SERVICE_FEE_ADDRESS);

  const { blockhash } = await getLatestBlockhash();

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.from.publicKey,
      toPubkey: toKey,
      lamports,
    }),
    SystemProgram.transfer({
      fromPubkey: params.from.publicKey,
      toPubkey: feeRecipient,
      lamports: feeLamports,
    })
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = params.from.publicKey;
  tx.sign(params.from);

  try {
    const signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await pollForConfirmation(conn, signature);

    return { signature, success: true };
  } catch (err: any) {
    return { signature: '', success: false, error: err.message };
  }
}

/**
 * Send SPL tokens to a recipient
 */
export async function sendSplToken(params: TransferParams): Promise<TransactionResult> {
  if (!params.mint || params.decimals === undefined) {
    throw new Error('Mint and decimals required for SPL token transfer');
  }

  const conn = getConnection();
  const mintKey = new PublicKey(params.mint);
  const toKey = new PublicKey(params.to);
  const amount = Math.round(params.amount * Math.pow(10, params.decimals));

  // Get source token account
  const fromAta = await getAssociatedTokenAddress(mintKey, params.from.publicKey);

  // Get or create destination token account
  const toAta = await getAssociatedTokenAddress(mintKey, toKey);

  const { blockhash } = await getLatestBlockhash();
  const tx = new Transaction();

  // Check if recipient has a token account, if not create one
  const toAtaInfo = await conn.getAccountInfo(toAta);
  if (!toAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        params.from.publicKey, // payer
        toAta,                 // ata
        toKey,                 // owner
        mintKey                // mint
      )
    );
  }

  // Transfer to recipient
  tx.add(
    createTransferInstruction(
      fromAta,               // source
      toAta,                 // destination
      params.from.publicKey, // owner
      amount                 // amount in smallest units
    )
  );

  // Service fee (1%) — sent as SOL
  const feeLamports = Math.round(params.amount * LAMPORTS_PER_SOL * SERVICE_FEE_RATE);
  const feeRecipient = new PublicKey(SERVICE_FEE_ADDRESS);
  tx.add(
    SystemProgram.transfer({
      fromPubkey: params.from.publicKey,
      toPubkey: feeRecipient,
      lamports: feeLamports,
    })
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = params.from.publicKey;
  tx.sign(params.from);

  try {
    const signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    await pollForConfirmation(conn, signature);

    return { signature, success: true };
  } catch (err: any) {
    return { signature: '', success: false, error: err.message };
  }
}

/**
 * Sign and submit a Jupiter swap transaction via the V2 /execute endpoint.
 * Jupiter handles landing, confirmation, and retry via Jupiter Beam.
 * After a successful swap, collects a 1% infrastructure fee in SOL.
 */
export async function signAndSubmitSwap(
  swapTransactionBase64: string,
  keypair: Keypair,
  requestId: string,
  feeLamports?: number,
): Promise<TransactionResult> {
  try {
    const txBuf = Buffer.from(swapTransactionBase64, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const signedBase64 = Buffer.from(tx.serialize()).toString('base64');

    const { executeSwap } = await import('./jupiter');
    const result = await executeSwap(signedBase64, requestId);

    if (result.status === 'Success') {
      // Collect 1% infrastructure fee in SOL
      if (feeLamports && feeLamports > 0) {
        try {
          await collectSwapFee(keypair, feeLamports);
        } catch (e) {
          console.warn('Infrastructure fee transfer failed:', e);
        }
      }
      return { signature: result.signature, success: true };
    } else {
      return { signature: result.signature || '', success: false, error: result.error || 'Swap failed' };
    }
  } catch (err: any) {
    return { signature: '', success: false, error: err.message };
  }
}

/**
 * Collect a 1% infrastructure fee in SOL.
 * Always sends SOL to the service fee address, regardless of swap tokens.
 */
async function collectSwapFee(
  keypair: Keypair,
  feeLamports: number,
): Promise<void> {
  if (feeLamports <= 0) return;

  const conn = getConnection();
  const feeRecipient = new PublicKey(SERVICE_FEE_ADDRESS);

  const { blockhash } = await getLatestBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = keypair.publicKey;

  tx.add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: feeRecipient,
      lamports: feeLamports,
    })
  );

  tx.sign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await pollForConfirmation(conn, sig, 15000);
}

/**
 * Estimate transaction fee
 */
export async function estimateFee(): Promise<number> {
  const conn = getConnection();
  const { feeCalculator } = await conn.getRecentBlockhash?.() ?? {};
  // Default priority fee estimate
  return feeCalculator?.lamportsPerSignature ?? 5000; // 0.000005 SOL
}

/**
 * Validate a Solana address
 */
export function isValidAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
