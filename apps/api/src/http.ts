/**
 * Turn a request body into something a schema can be asked about.
 *
 * `JSON.parse` throws, and every call site here feeds its result straight into a zod `safeParse`
 * whose entire job is to answer "is this valid?" without throwing. Parsing outside that guard
 * meant a malformed body escaped as an unhandled exception and became a 500 — the API telling a
 * caller *it* had broken, when the caller had sent bad JSON.
 *
 * Returns `null` for anything unparseable so the caller can answer 400 in the same shape it
 * already answers a schema failure. An absent body is `{}`, which is what an empty POST means and
 * what the schemas are written to reject on their own terms.
 */
export function parseJsonBody(body: string | undefined): unknown | null {
  try {
    return JSON.parse(body ?? '{}');
  } catch {
    return null;
  }
}
