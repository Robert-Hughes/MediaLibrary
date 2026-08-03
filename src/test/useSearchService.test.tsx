import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MEDIA_LIBRARY_SEARCH_RESULT_EVENT,
  useSearchService,
  type SearchTauriApi,
} from "../hooks/useSearchService";
import type {
  MediaLibrarySearchRequest,
  MediaLibrarySearchResult,
} from "../types";

interface PendingInvoke {
  request: MediaLibrarySearchRequest;
  resolve: (result: MediaLibrarySearchResult) => void;
  reject: (error: unknown) => void;
}

class FakeSearchApi implements SearchTauriApi {
  readonly invokes: PendingInvoke[] = [];
  private listeners = new Set<(result: MediaLibrarySearchResult) => void>();

  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    expect(command).toBe("search_media_library_session");
    const request = args?.request as MediaLibrarySearchRequest;
    return new Promise<T>((resolve, reject) => {
      this.invokes.push({
        request,
        resolve: (result) => resolve(result as T),
        reject,
      });
    });
  }

  async listen<T>(
    event: string,
    handler: (payload: T) => void,
  ): Promise<() => void> {
    expect(event).toBe(MEDIA_LIBRARY_SEARCH_RESULT_EVENT);
    const typed = handler as (result: MediaLibrarySearchResult) => void;
    this.listeners.add(typed);
    return () => this.listeners.delete(typed);
  }

  emit(result: MediaLibrarySearchResult) {
    for (const listener of this.listeners) listener(result);
  }
}

function resultFor(
  request: MediaLibrarySearchRequest,
  matchedPaths: string[],
  revision = 10,
): MediaLibrarySearchResult {
  return {
    session_id: request.session_id,
    request_id: request.request_id,
    session_revision: revision,
    matched_paths: matchedPaths,
    has_edits_filter: request.query.toLowerCase().includes("has:edits"),
  };
}

describe("useSearchService", () => {
  it("shows pending until the asynchronous command returns, including empty results", async () => {
    const api = new FakeSearchApi();
    const { result } = renderHook(() =>
      useSearchService({ sessionId: 7, query: "missing", debounceMs: 0, api }),
    );

    await waitFor(() => expect(api.invokes).toHaveLength(1));
    expect(result.current.pending).toBe(true);
    act(() => api.invokes[0].resolve(resultFor(api.invokes[0].request, [])));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.matched).toEqual(new Set());
  });

  it("accepts only the latest request when command results arrive out of order", async () => {
    const api = new FakeSearchApi();
    const rendered = renderHook(
      ({ query }) =>
        useSearchService({ sessionId: 7, query, debounceMs: 0, api }),
      { initialProps: { query: "first" } },
    );
    await waitFor(() => expect(api.invokes).toHaveLength(1));
    rendered.rerender({ query: "second" });
    await waitFor(() => expect(api.invokes).toHaveLength(2));

    act(() =>
      api.invokes[1].resolve(resultFor(api.invokes[1].request, ["new.jpg"])),
    );
    await waitFor(() =>
      expect(rendered.result.current.matched).toEqual(new Set(["new.jpg"])),
    );
    act(() =>
      api.invokes[0].resolve(resultFor(api.invokes[0].request, ["old.jpg"])),
    );
    await act(async () => void (await Promise.resolve()));
    expect(rendered.result.current.matched).toEqual(new Set(["new.jpg"]));
  });

  it.each([
    "files arriving mid-search",
    "metadata changing mid-search",
    "draft changes mid-search",
  ])("applies revision-tagged backend refresh events for %s", async () => {
    const api = new FakeSearchApi();
    const { result } = renderHook(() =>
      useSearchService({ sessionId: 7, query: "needle", debounceMs: 0, api }),
    );
    await waitFor(() => expect(api.invokes).toHaveLength(1));
    const request = api.invokes[0].request;
    act(() => api.invokes[0].resolve(resultFor(request, [])));
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));

    act(() => api.emit(resultFor(request, ["arrived.jpg"], 11)));
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["arrived.jpg"])),
    );
  });

  it("ignores results from a replaced session", async () => {
    const api = new FakeSearchApi();
    const rendered = renderHook(
      ({ sessionId }) =>
        useSearchService({ sessionId, query: "needle", debounceMs: 0, api }),
      { initialProps: { sessionId: 7 as number | null } },
    );
    await waitFor(() => expect(api.invokes).toHaveLength(1));
    const oldRequest = api.invokes[0].request;
    rendered.rerender({ sessionId: 8 });
    await waitFor(() => expect(api.invokes).toHaveLength(2));
    const newRequest = api.invokes[1].request;

    act(() => api.emit(resultFor(oldRequest, ["old.jpg"], 20)));
    expect(rendered.result.current.matched).toBeNull();
    act(() => api.invokes[1].resolve(resultFor(newRequest, ["new.jpg"], 21)));
    await waitFor(() =>
      expect(rendered.result.current.matched).toEqual(new Set(["new.jpg"])),
    );
  });

  it("clearing search immediately restores the complete frontend list", async () => {
    const api = new FakeSearchApi();
    const rendered = renderHook(
      ({ query }) =>
        useSearchService({ sessionId: 7, query, debounceMs: 0, api }),
      { initialProps: { query: "needle" } },
    );
    await waitFor(() => expect(api.invokes).toHaveLength(1));
    act(() =>
      api.invokes[0].resolve(resultFor(api.invokes[0].request, ["one.jpg"])),
    );
    await waitFor(() =>
      expect(rendered.result.current.matched).toEqual(new Set(["one.jpg"])),
    );

    rendered.rerender({ query: "" });
    await waitFor(() => expect(rendered.result.current.matched).toBeNull());
    expect(rendered.result.current.pending).toBe(false);
    expect(api.invokes).toHaveLength(1);
  });
});
