//app/hooks/useSelectedAccount.ts
'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  initBroadcastChannel,
  sendMessage,
  sendMessageOptional,
  closeBroadcastChannel,
  isReady,
} from '../../src/bc';

export type SelectedAccount = {
  account_id: string;
  access_level?: number;
    tblaccount: {
      name: string | null;
    };
} | null;

const LOCAL_KEY = 'selectedAccount';
const CHANNEL_NAME = 'selectedAccountChannel';

export default function useSelectedAccount() {
  const [account, setAccount] = useState<SelectedAccount>(() => {
    try {
      if (typeof window === 'undefined') return null;
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const setSelectedAccount = useCallback((a: SelectedAccount) => {
    try {
      if (typeof window === 'undefined') {
        // server side - just update state (shouldn't normally happen in client hook)
        setAccount(a);
        return;
      }

      if (a) {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(a));
        // Also set a cookie so server-side can read the selected account
        document.cookie = `${LOCAL_KEY}=${encodeURIComponent(JSON.stringify(a))}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
        window.dispatchEvent(new CustomEvent('accountChanged', { detail: a }));
      } else {
        localStorage.removeItem(LOCAL_KEY);
        // Remove the cookie by setting it to expire
        document.cookie = `${LOCAL_KEY}=; path=/; max-age=0; SameSite=Lax`;
        window.dispatchEvent(new CustomEvent('accountChanged', { detail: null }));
      }
      setAccount(a);

      // Broadcast to other tabs/contexts. Prefer the shared BroadcastChannel managed
      // by src/bc helpers. If not available/initialized, fall back to the previous
      // behaviors (temporary BroadcastChannel, StorageEvent, CustomEvent).
      try {
        // If BroadcastChannel API exists in the environment:
        if (typeof BroadcastChannel !== 'undefined') {
          try {
            // Prefer the managed channel if initialized
            if (isReady()) {
              sendMessage({ type: 'selectedAccount', payload: a });
            } else {
              // If our shared channel hasn't been initialized yet in this context,
              // send a one-off message via a temporary BroadcastChannel (preserves original behavior).
              const tmp = new (BroadcastChannel as any)(CHANNEL_NAME);
              tmp.postMessage({ type: 'selectedAccount', payload: a });
              try {
                tmp.close();
              } catch {
                // ignore close errors
              }
            }
          } catch {
            // As a last resort for BroadcastChannel usage, try the concise optional helper.
            // This will no-op if the shared channel doesn't exist.
            sendMessageOptional({ type: 'selectedAccount', payload: a });
          }
        } else {
          // Fallback: dispatch a StorageEvent so other tabs hear it.
          // Constructing StorageEvent can throw in some environments; guard with try/catch.
          try {
            const ev = new StorageEvent('storage', {
              key: LOCAL_KEY,
              newValue: a ? JSON.stringify(a) : null,
            } as any);
            (window as any).dispatchEvent(ev);
          } catch {
            // final fallback: custom event
            const ev2 = new CustomEvent('selectedAccount:changed', {
              detail: { key: LOCAL_KEY, newValue: a ? JSON.stringify(a) : null },
            });
            (window as any).dispatchEvent(ev2);
          }
        }
      } catch (err) {
        // best-effort; ignore broadcasting errors
        console.warn('broadcast selectedAccount failed', err);
      }
    } catch (err) {
      console.error('setSelectedAccount error', err);
    }
  }, []);

  // Sync cookie on mount if localStorage has a value but cookie might not
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // If we have an account in state (from localStorage), ensure the cookie is also set
    if (account) {
      document.cookie = `${LOCAL_KEY}=${encodeURIComponent(JSON.stringify(account))}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
    }
  }, []); // Run once on mount

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Handler for BroadcastChannel messages
    const bcHandler = (ev: MessageEvent) => {
      if ((ev as any)?.data?.type === 'selectedAccount') {
        setAccount((ev as any).data.payload ?? null);
      }
    };

    // Initialize the shared BroadcastChannel and attach handler.
    // This replaces direct `bc = new BroadcastChannel(...)` and `bc.onmessage = ...`.
    try {
      initBroadcastChannel(CHANNEL_NAME, bcHandler);
    } catch {
      // ignore initialization errors — we'll still have storage/custom event fallbacks
    }

    // Storage event handler (other tabs)
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCAL_KEY) {
        try {
          setAccount(e.newValue ? JSON.parse(e.newValue) : null);
        } catch {
          setAccount(null);
        }
      }
    };

    // Custom event handler (fallback)
    const onCustom = (ev: any) => {
      try {
        const d = ev?.detail?.newValue ? JSON.parse(ev.detail.newValue) : null;
        setAccount(d);
      } catch {
        setAccount(null);
      }
    };

    // Listen to native storage events (other tabs) and a custom fallback event
    window.addEventListener('storage', onStorage);
    window.addEventListener('selectedAccount:changed' as any, onCustom);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('selectedAccount:changed' as any, onCustom);

      // Close the shared BroadcastChannel if we opened it.
      // This replaces any direct bc.close() usage.
      try {
        closeBroadcastChannel();
      } catch {
        // ignore close errors
      }
    };
  }, []);

  return { account, setSelectedAccount };
}
