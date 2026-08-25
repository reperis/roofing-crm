import { useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Run an async query and expose its three real states.
 *
 * Queries here run against remote Parquet over byte-range requests, so "loading" is a genuine,
 * visible state rather than a formality, and a failed range request must surface as an error
 * rather than an empty table — an empty result and a broken fetch mean very different things to
 * someone deciding whether a lead list is trustworthy.
 */
export function useAsync<T>(factory: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    factory().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            data: null,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          });
        }
      },
    );

    return () => {
      // Dragging the radius slider fires queries faster than they resolve; without this an older,
      // slower result can land after a newer one and silently show stale rows.
      cancelled = true;
    };
    // `deps` is the caller's array, passed through verbatim. This hook cannot know what its
    // factory closes over, so the caller owns that decision — the same reason React's own rule
    // cannot see through it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns this array
  }, deps);

  return state;
}
