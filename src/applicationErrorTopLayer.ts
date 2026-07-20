const APPLICATION_ERROR_TOP_LAYER_EVENT =
  "medialibrary:application-error-bring-to-front";

export function requestApplicationErrorBringToFront(): void {
  window.dispatchEvent(new Event(APPLICATION_ERROR_TOP_LAYER_EVENT));
}

export function listenForApplicationErrorBringToFront(
  listener: () => void,
): () => void {
  window.addEventListener(APPLICATION_ERROR_TOP_LAYER_EVENT, listener);
  return () =>
    window.removeEventListener(APPLICATION_ERROR_TOP_LAYER_EVENT, listener);
}
