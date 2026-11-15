/** Whether a request carries the administrator's token. */
export function isAdminRequest(token: string, adminToken: string): boolean {
  if (token === adminToken) {
    return true;
  }
  return false;
}
