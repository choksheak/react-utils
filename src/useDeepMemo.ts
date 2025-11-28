/**
 * @packageDocumentation
 *
 * Provides a memoized value in React where the value is checked for deep
 * equality. If the value has changed, but is deeply equal to the previous
 * value, then useDeepMemo will return the same reference to the previous
 * value and ignore the latest value.
 *
 * This is mainly used in shared queries to check for changes in the query
 * arguments, but it might be useful for your own use cases.
 */

import isEqual from "lodash/isEqual";
import { useMemo, useState } from "react";

/**
 * Provides a stable value for T based on deep equality. The deep equality is
 * determined by the `isEqual()` function in lodash.
 */
export function useDeepMemo<T>(value: T): T {
  const [state, setState] = useState<T>(value);

  return useMemo(() => {
    if (isEqual(state, value)) {
      return state;
    }

    // We check equality, so this should be safe.
    // eslint-disable-next-line react-hooks/set-state-in-render
    setState(value);

    return value;
  }, [state, value]);
}
