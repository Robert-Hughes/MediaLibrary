interface ApplicationErrorTopLayerState {
  target: HTMLDialogElement | null;
  revision: number;
}

const dialogs: HTMLDialogElement[] = [];
const listeners = new Set<() => void>();
let state: ApplicationErrorTopLayerState = { target: null, revision: 0 };

function publish(): void {
  for (let index = dialogs.length - 1; index >= 0; index -= 1) {
    if (!dialogs[index].isConnected || !dialogs[index].open) {
      dialogs.splice(index, 1);
    }
  }
  state = {
    target: dialogs[dialogs.length - 1] ?? null,
    revision: state.revision + 1,
  };
  listeners.forEach((listener) => listener());
}

export function registerApplicationErrorDialog(
  dialog: HTMLDialogElement,
): () => void {
  const existing = dialogs.indexOf(dialog);
  if (existing >= 0) dialogs.splice(existing, 1);
  dialogs.push(dialog);
  publish();

  return () => {
    const index = dialogs.indexOf(dialog);
    if (index < 0) return;
    dialogs.splice(index, 1);
    publish();
  };
}

export function subscribeApplicationErrorTopLayer(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getApplicationErrorTopLayerState(): ApplicationErrorTopLayerState {
  return state;
}
