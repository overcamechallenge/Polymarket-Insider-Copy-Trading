/**
 * Temporarily suppress console.error while running CLOB SDK calls that log raw HTTP errors.
 */
export async function withSilencedSdkConsole<T>(
    enabled: boolean,
    fn: () => Promise<T>
): Promise<T> {
    if (!enabled) {
        return fn();
    }
    const prev = console.error;
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.error = prev;
    }
}
