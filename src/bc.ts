// Type-safe BroadcastChannel wrapper.
// Treats `bc` as possibly null and exposes safe helper functions.

// If you use this in an environment where `BroadcastChannel` might not exist
// (e.g. Node, older browsers), we check for it during init.

export type BC = BroadcastChannel | null;

let bc: BC = null;

/**
 * Initialize the BroadcastChannel.
 * If BroadcastChannel isn't available, bc remains null.
 */
export function initBroadcastChannel(name: string, onMessage?: (ev: MessageEvent) => void): void {
  if (typeof BroadcastChannel === 'undefined') {
    // Environment doesn't support BroadcastChannel
    console.warn('BroadcastChannel is not available in this environment.');
    bc = null;
    return;
  }

  // close previous channel if any
  closeBroadcastChannel();

  bc = new BroadcastChannel(name);
  if (onMessage) {
    bc.onmessage = onMessage;
  }
}

/**
 * Send a message if the channel exists.
 * Safe because we check bc before calling postMessage.
 */
export function sendMessage(message: unknown): void {
  // Guard narrowing is the most explicit and recommended approach
  if (!bc) {
    // handle the "not initialized" case however you need
    console.warn('BroadcastChannel not initialized — message not sent', message);
    return;
  }

  bc.postMessage(message);
}

/**
 * Send a message using optional chaining.
 * This is concise and safe: if bc is null, nothing happens.
 */
export function sendMessageOptional(message: unknown): void {
  bc?.postMessage(message);
}

/**
 * Close the broadcast channel if it exists.
 */
export function closeBroadcastChannel(): void {
  if (bc) {
    bc.close();
    bc = null;
  }
}

/**
 * Return whether the broadcast channel is ready.
 */
export function isReady(): boolean {
  return bc !== null;
}

/**
 * Example of a type-guard helper (optional):
 * Use this when you want a reusable runtime check.
 */
export function assertBcExists(): BroadcastChannel {
  if (!bc) {
    throw new Error('BroadcastChannel not initialized');
  }
  return bc;
}

/**
 * Example usage notes:
 * - Prefer explicit guards (if (!bc) return) where it makes sense.
 * - Optional chaining (bc?.postMessage(...)) is good when "no-op" is acceptable.
 * - Avoid using the non-null assertion `bc!.postMessage(...)` unless you are certain bc is set.
 */