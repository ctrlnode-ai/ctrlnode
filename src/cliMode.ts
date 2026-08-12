/** Returns whether the Bridge was invoked for its device-login flow. */
export function isLoginCommand(args: readonly string[]): boolean {
  return args.includes('login') || args.includes('--login');
}
