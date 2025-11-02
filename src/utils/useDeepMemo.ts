import isEqual from "lodash/isEqual";
import { useMemo, useState } from "react";

/** Provides a stable value for T based on deep equality. */
export function useDeepMemo<T>(value: T): T {
  const [state, setState] = useState<T>(value);

  return useMemo(() => {
    if (state === value || isEqual(state, value)) {
      return state;
    }

    // We check equality, so this should be safe.
    // eslint-disable-next-line react-hooks/set-state-in-render
    setState(value);

    return value;
  }, [state, value]);
}
