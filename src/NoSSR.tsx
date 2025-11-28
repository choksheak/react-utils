/**
 * @packageDocumentation
 *
 * Wraps components in <NoSSR>...</NoSSR> to make sure they only render on the
 * client side, and not on the server side.
 */

import React, { ReactNode, useEffect, useState } from "react";

/** Props for the NoSSR component. */
export type NoSSRProps = {
  /** The content to render only on the client side. */
  children: ReactNode;

  /** A component to render during SSR or initial load. */
  fallback?: ReactNode;
};

/**
 * A component that prevents its children from being rendered during
 * Server-Side Rendering (SSR). It renders a optional fallback during SSR, and
 * only renders its children after the component has mounted on the client.
 */
export const NoSSR: React.FC<NoSSRProps> = ({ children, fallback }) => {
  const [isClient, setIsClient] = useState(false);

  // 2. useEffect runs ONLY on the client after the initial hydration is complete.
  useEffect(() => {
    // This forces the component to render a second time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsClient(true);
  }, []);

  return isClient ? children : fallback;
};
