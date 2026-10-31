import { loadModule } from "./module";
import { KeyStore, indexedDbStorage } from "./store";

/**
 * The page's one key store: the identity kept in this browser's IndexedDB, opened with the module served at `/fjord-wasm/`. One per page load, so an
 * identity that is unlocked stays unlocked as the person moves between pages of the app (client-side navigation) and is gone when the tab is.
 * Browser only: it is made on first use, never while a page is rendered on the server.
 */
let store: KeyStore | undefined;
let onLockListeners: (() => void)[] = [];

export function keyStore(): KeyStore {
  store ??= new KeyStore({
    module: loadModule,
    storage: indexedDbStorage(),
    onLock: () => onLockListeners.forEach((listener) => listener()),
  });
  return store;
}

/** Be told when the identity locks itself after a quiet period. Returns how to stop. */
export function onAutoLock(listener: () => void): () => void {
  onLockListeners = [...onLockListeners, listener];
  return () => {
    onLockListeners = onLockListeners.filter((other) => other !== listener);
  };
}
