/** Build the fixed login route; the server revalidates `next` with safeReturnTo before using it. */
export function sessionRecoveryLoginPath(returnTo: string): string {
  const params = new URLSearchParams();
  if (returnTo !== "/") params.set("next", returnTo);
  params.set("recover", "1");
  return `/auth/login?${params.toString()}`;
}
