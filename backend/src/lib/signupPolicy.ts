import { ssoDomainSchema } from "./ssoConfig";

// Deployment-wide sign-up gate. SIGNUP_ALLOWED_DOMAINS is a comma-separated
// list of exact email domains; unset means anyone may register (upstream
// default). This is the friendly, route-level check — a deployment that needs
// hard enforcement also adds a BEFORE INSERT trigger on auth.users, because
// the publishable key lets a client call GoTrue directly.

export const SIGNUP_DOMAIN_NOT_ALLOWED = {
  code: "signup_domain_not_allowed",
  detail: "Sign-up is limited to approved company email addresses.",
} as const;

/** A user created this recently is treated as a sign-up rather than a login. */
const FRESH_ACCOUNT_WINDOW_MS = 10 * 60 * 1000;

export function signupAllowedDomains(
  env: NodeJS.ProcessEnv = process.env,
): string[] | null {
  const raw = env.SIGNUP_ALLOWED_DOMAINS?.trim();
  if (!raw) return null;
  const domains = raw
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => ssoDomainSchema.parse(domain));
  return domains.length ? domains : null;
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

export function signupDomainAllowed(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const allowed = signupAllowedDomains(env);
  if (!allowed) return true;
  if (!email) return false;
  return allowed.includes(emailDomain(email));
}

/**
 * OAuth sign-ups never hit /auth/signup: GoTrue creates the account during the
 * provider callback. Treat an account created moments ago as a sign-up so the
 * same domain rule applies, while established accounts keep logging in.
 */
export function isFreshAccount(
  user: { created_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (!user.created_at) return false;
  const created = Date.parse(user.created_at);
  if (Number.isNaN(created)) return false;
  return now - created < FRESH_ACCOUNT_WINDOW_MS;
}
