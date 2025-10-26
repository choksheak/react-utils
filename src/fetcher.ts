import wretch from "wretch";
import { retry } from "wretch/middlewares";

/** Name this as "fetcher" to make it easier to understand. */
export const fetcher = wretch();

/** Fetcher with default short retries. */
export const fetcherWithRetries = wretch().middlewares([
    retry({
        maxAttempts: 3,
        delayTimer: 1000,
        retryOnNetworkError: true
    })
]);
