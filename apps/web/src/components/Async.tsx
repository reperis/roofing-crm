import type { ReactNode } from 'react';

import type { AsyncState } from '../hooks/useAsync';

interface AsyncBoundaryProps<T> {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  /** What is being loaded, so the pending state says something useful. */
  label: string;
  empty?: (data: T) => boolean;
  emptyMessage?: string;
}

/**
 * Render the three outcomes of a query distinctly.
 *
 * An error must never render as an empty table: "no properties match your filters" and "the
 * dataset could not be reached" look identical if both produce a blank panel, and only one of
 * them means the user should widen their search.
 */
export function AsyncBoundary<T>({
  state,
  children,
  label,
  empty,
  emptyMessage = 'No matching records.',
}: AsyncBoundaryProps<T>) {
  if (state.loading) {
    return (
      <p className="status status--loading" role="status">
        Loading {label}…
      </p>
    );
  }

  if (state.error !== null) {
    return (
      <p className="status status--error" role="alert">
        Could not load {label} — {state.error.message}
      </p>
    );
  }

  if (state.data === null) {
    return <p className="status status--error">No result for {label}.</p>;
  }

  if (empty?.(state.data) === true) {
    return <p className="status status--empty">{emptyMessage}</p>;
  }

  return <>{children(state.data)}</>;
}
