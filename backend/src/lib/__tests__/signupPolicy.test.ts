import { describe, expect, it } from "vitest";
import {
  emailDomain,
  isFreshAccount,
  signupAllowedDomains,
  signupDomainAllowed,
} from "../signupPolicy";

describe("signupPolicy", () => {
  it("treats an unset or blank allowlist as open sign-up", () => {
    expect(signupAllowedDomains({})).toBeNull();
    expect(signupAllowedDomains({ SIGNUP_ALLOWED_DOMAINS: "  " })).toBeNull();
    expect(signupDomainAllowed("x@anywhere.test", {})).toBe(true);
    expect(signupDomainAllowed(null, {})).toBe(true);
  });

  it("parses a comma-separated list and matches domains case-insensitively", () => {
    const env = { SIGNUP_ALLOWED_DOMAINS: " Dashelectric.co ,example.test, " };
    expect(signupAllowedDomains(env)).toEqual(["dashelectric.co", "example.test"]);
    expect(signupDomainAllowed("robert@DashElectric.co", env)).toBe(true);
    expect(signupDomainAllowed("robert@gmail.com", env)).toBe(false);
    expect(signupDomainAllowed("robert@sub.dashelectric.co", env)).toBe(false);
    expect(signupDomainAllowed(null, env)).toBe(false);
    expect(signupDomainAllowed("", env)).toBe(false);
  });

  it("rejects malformed domain entries loudly", () => {
    expect(() => signupAllowedDomains({ SIGNUP_ALLOWED_DOMAINS: "@dashelectric.co" })).toThrow();
    expect(() => signupAllowedDomains({ SIGNUP_ALLOWED_DOMAINS: "*.dashelectric.co" })).toThrow();
  });

  it("extracts the domain after the last @", () => {
    expect(emailDomain("a@b@Dash.co")).toBe("dash.co");
    expect(emailDomain("no-at")).toBe("");
  });

  it("only treats recently created accounts as sign-ups", () => {
    const now = Date.parse("2026-09-22T10:00:00.000Z");
    expect(isFreshAccount({ created_at: "2026-09-22T09:55:00.000Z" }, now)).toBe(true);
    expect(isFreshAccount({ created_at: "2026-09-22T09:40:00.000Z" }, now)).toBe(false);
    expect(isFreshAccount({ created_at: null }, now)).toBe(false);
    expect(isFreshAccount({ created_at: "garbage" }, now)).toBe(false);
  });
});
