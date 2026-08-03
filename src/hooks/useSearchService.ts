import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MediaLibrarySearchRequest,
  MediaLibrarySearchResult,
} from "../types";

export const MEDIA_LIBRARY_SEARCH_RESULT_EVENT = "media_library_search_result";

export interface SearchTauriApi {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
}

const productionApi: SearchTauriApi = {
  invoke,
  async listen<T>(event: string, handler: (payload: T) => void) {
    return listen<T>(event, ({ payload }) => handler(payload));
  },
};

export interface UseSearchServiceArgs {
  sessionId: number | null;
  query: string;
  debounceMs?: number;
  api?: SearchTauriApi;
}

export interface UseSearchServiceResult {
  matched: Set<string> | null;
  pending: boolean;
}

export function useSearchService({
  sessionId,
  query,
  debounceMs = 150,
  api = productionApi,
}: UseSearchServiceArgs): UseSearchServiceResult {
  const requestIdRef = useRef(0);
  const currentSessionRef = useRef<number | null>(sessionId);
  const currentQueryRef = useRef(query);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [matched, setMatched] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState(false);

  currentSessionRef.current = sessionId;
  currentQueryRef.current = query;

  const acceptResult = useCallback((result: MediaLibrarySearchResult) => {
    if (result.session_id !== currentSessionRef.current) return;
    if (result.request_id !== requestIdRef.current) return;
    setMatched(new Set(result.matched_paths));
    setPending(false);
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    void api
      .listen<MediaLibrarySearchResult>(
        MEDIA_LIBRARY_SEARCH_RESULT_EVENT,
        (result) => {
          if (active) acceptResult(result);
        },
      )
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [acceptResult, api]);

  useEffect(() => {
    requestIdRef.current += 1;
    setMatched(null);
    setPending(false);
  }, [sessionId]);

  const submitNow = useCallback(
    (submittedSessionId: number | null, submittedQuery: string) => {
      const requestId = ++requestIdRef.current;
      if (submittedSessionId === null || submittedQuery.trim().length === 0) {
        setMatched(null);
        setPending(false);
        return;
      }

      const request: MediaLibrarySearchRequest = {
        session_id: submittedSessionId,
        request_id: requestId,
        query: submittedQuery,
      };
      setPending(true);
      void api
        .invoke<MediaLibrarySearchResult>("search_media_library_session", {
          request,
        })
        .then(acceptResult)
        .catch(() => {
          if (
            currentSessionRef.current === submittedSessionId &&
            requestIdRef.current === requestId
          ) {
            setPending(false);
          }
        });
    },
    [acceptResult, api],
  );

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (debounceMs === 0) {
      submitNow(sessionId, query);
      return;
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      submitNow(sessionId, query);
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [debounceMs, query, sessionId, submitNow]);

  return { matched, pending };
}
