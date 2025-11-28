/**
 * @packageDocumentation
 *
 * An alternate syntax to fetch() that allows function chaining to compose the
 * entire fetch request. One can also compose partial fetcher objects to be
 * reused in future requests.
 *
 * Examples:
 * ```
 *   const userFetcher = fetcher
 *     .auth("Bearer TOPSECRET")
 *     .content("application/json")
 *     .url("/api/user");
 *
 *   const user = await userFetcher.get();
 *
 *   const updateResult = await userFetcher
 *     .body({ id: user.id, name: "New name"})
 *     .post();
 * ```
 */

import wretch from "wretch";
import { retry } from "wretch/middlewares";

/**
 * Fetcher with default short retries. Use this to make your queries more
 * robust without any additional work.
 */
export const fetcher = wretch().middlewares([
  retry({
    maxAttempts: 3,
    delayTimer: 1000,
    retryOnNetworkError: true,
  }),
]);

/**
 * Name this as `fetcherNoRetries` to make it easier to understand than
 * `wretch`. Use this if you don't want retries. Use `fetcher` if you want
 * retries.
 */
export const fetcherNoRetries = wretch();
