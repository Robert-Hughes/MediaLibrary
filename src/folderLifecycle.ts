import type { MediaLibrarySessionSnapshot } from "./types";

export type FolderIntent = "open" | "refresh";
export interface FolderLifecycle {
  phase:
    | "idle"
    | "opening"
    | "discovering"
    | "metadata"
    | "ready"
    | "closing"
    | "failed";
  folder: string | null;
  sessionId: number | null;
  intent: FolderIntent | null;
  canOpen: boolean;
  canRefresh: boolean;
  canClose: boolean;
}

/** Presentation of Rust session phases plus an immediate pending-command phase.
 * Metadata counts remain in the existing observable projection. Only phase
 * changes notify React, so each metadata batch does not rerender the app root.
 */
export function createFolderLifecycle(getMetadataRemaining: () => number) {
  let session: Pick<
    MediaLibrarySessionSnapshot,
    "session_id" | "folder" | "lifecycle" | "discovery_running"
  > = {
    session_id: null,
    folder: null,
    lifecycle: "idle",
    discovery_running: false,
  };
  let pending: { phase: "opening" | "closing"; folder: string } | null = null;
  let intent: FolderIntent | null = null;
  let openingFailed = false;
  const subscribers = new Set<() => void>();

  const current = (): FolderLifecycle => {
    let phase: FolderLifecycle["phase"];
    if (pending) phase = pending.phase;
    else if (openingFailed) phase = "failed";
    else if (session.lifecycle !== "loaded") phase = session.lifecycle;
    else if (session.discovery_running) phase = "discovering";
    else if (getMetadataRemaining() > 0) phase = "metadata";
    else phase = "ready";
    const folder = pending?.folder ?? session.folder;
    const transitioning = phase === "opening" || phase === "closing";
    return {
      phase,
      folder,
      sessionId: session.session_id,
      intent:
        phase === "opening" || phase === "discovering" || phase === "metadata"
          ? intent
          : null,
      canOpen: !transitioning,
      canRefresh: folder !== null && (phase === "ready" || phase === "failed"),
      canClose: folder !== null && !transitioning && phase !== "idle",
    };
  };
  let snapshot = current();
  const publish = () => {
    const next = current();
    if (
      next.phase === snapshot.phase &&
      next.folder === snapshot.folder &&
      next.sessionId === snapshot.sessionId &&
      next.intent === snapshot.intent
    )
      return;
    snapshot = next;
    subscribers.forEach((subscriber) => subscriber());
  };

  return {
    getSnapshot: () => snapshot,
    getCurrent: current,
    subscribe: (subscriber: () => void) => {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    updateProgress: publish,
    projectSnapshot: (next: MediaLibrarySessionSnapshot) => {
      session = {
        session_id: next.session_id,
        folder: next.folder,
        lifecycle: next.lifecycle,
        discovery_running: next.discovery_running,
      };
      openingFailed = false;
      if (!pending && next.lifecycle === "opening") intent = "open";
      publish();
    },
    projectDiscovery: (sessionId: number, running: boolean) => {
      if (sessionId !== session.session_id) return;
      session = { ...session, discovery_running: running };
      publish();
    },
    beginOpen: (folder: string, nextIntent: FolderIntent) => {
      const state = current();
      if (!state.canOpen || (nextIntent === "refresh" && !state.canRefresh))
        return false;
      pending = { phase: "opening", folder };
      intent = nextIntent;
      openingFailed = false;
      publish();
      return true;
    },
    finishOpen: (failed = false) => {
      pending = null;
      openingFailed = failed && session.lifecycle === "opening";
      publish();
    },
    beginClose: () => {
      const state = current();
      if (!state.canClose || state.folder === null) return false;
      pending = { phase: "closing", folder: state.folder };
      publish();
      return true;
    },
    finishClose: () => {
      pending = null;
      publish();
    },
  };
}
