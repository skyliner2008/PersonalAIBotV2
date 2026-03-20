/**
 * Centralized webhook path matcher for raw-body routes.
 * LINE signature verification requires exact raw request payload bytes.
 */
export function requiresRawWebhookBody(requestPath: string): boolean {
  if (!requestPath) return false;
  return requestPath === '/webhook'
    || requestPath === '/webhook/line'
    || requestPath.startsWith('/webhook/line/');
}
