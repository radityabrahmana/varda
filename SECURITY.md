# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| tip of `main` | ✅ |

Security fixes land only on `main`. If you are self-hosting, please update to
the latest `main` before reporting — the issue may already be fixed.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:

**Security tab → Report a vulnerability** on this repository
(GitHub's private vulnerability reporting).

Please do not open a public issue for anything security-sensitive.

You can expect an acknowledgment within 7 days; fixes are prioritized by
severity after that.

## Scope

- Reports about the code, default configuration, and deployment guidance in
  this repo are all in scope.
- The **hosted service at `varda.dashelectric.co`** is in scope — report issues affecting it through
  the same private channel above, and please keep testing non-destructive:
  only accounts and data you own, no denial of service, no access to other
  users' data beyond the minimum proof needed.
- **Independent self-hosted installations** run by third parties are the one
  exclusion: findings that only apply to how a specific outside operator has
  deployed Varda (their infrastructure, their configuration) should go to
  whoever operates that deployment.
- Varda is an **LLM legal product**, so LLM-specific reports are explicitly
  welcome: prompt injection (including via uploaded documents), getting the
  model to ignore its guardrails, leaking another user's data or system
  prompts through model output, and similar.
- Secrets accidentally committed to this repository's history are also worth
  a private report, even though CI runs a secret scanner.
