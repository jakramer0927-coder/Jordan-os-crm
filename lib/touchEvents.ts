// Lightweight cross-component signal for "a touch/interaction was just logged".
// Any logging surface fires emitTouchLogged(); pages that display contact
// recency listen for it and refresh, so the UI never shows a stale
// last-contact time after a log (the DB trigger already updates the data).

export const TOUCH_LOGGED_EVENT = "dex:touch-logged";

export function emitTouchLogged(contactId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOUCH_LOGGED_EVENT, { detail: { contactId } }));
}

export function onTouchLogged(handler: (contactId?: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent).detail?.contactId);
  window.addEventListener(TOUCH_LOGGED_EVENT, listener);
  return () => window.removeEventListener(TOUCH_LOGGED_EVENT, listener);
}
