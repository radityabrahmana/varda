import { UserFacingError } from "../userFacingError";
import { asInvalidApiKeyError } from "./apiKeyErrors";

type ProviderContext = { label: string; modelId: string };

type ApiCallErrorLike = Error & { statusCode: number; responseBody?: string };

// The AI SDK is ESM-only here, so match its error shapes rather than importing
// APICallError / RetryError classes. Retried failures (e.g. 429s) arrive as a
// RetryError whose status code lives on `lastError`.
function findApiCallError(error: unknown): ApiCallErrorLike | null {
  if (!(error instanceof Error)) return null;
  if (typeof (error as Partial<ApiCallErrorLike>).statusCode === "number") {
    return error as ApiCallErrorLike;
  }
  const lastError = (error as { lastError?: unknown }).lastError;
  return lastError === undefined ? null : findApiCallError(lastError);
}

// "The" rather than "your" key: requiredKey() may fall back to the
// deployment's key, as noted on InvalidApiKeyError.
function accessFailureMessage(
  { statusCode, responseBody = "" }: ApiCallErrorLike,
  { label, modelId }: ProviderContext,
): string | null {
  if (statusCode === 402) {
    return `The ${label} account is out of credits. Top up, or select another model.`;
  }
  if (statusCode === 403 || statusCode === 404) {
    return `${modelId} isn't available with the ${label} API key. Select another model.`;
  }
  if (statusCode === 429) {
    return /limit: 0\b/.test(responseBody)
      ? `The ${label} plan doesn't include ${modelId}. Select another model, or upgrade the ${label} plan.`
      : `${label} rate limit or quota reached. Wait a moment and try again, or select another model.`;
  }
  return null;
}

function errorMessage(error: unknown, label: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `${label} stream failed.`;
}

/**
 * Convert a provider failure into the error we throw.
 *
 * Key and access failures become `UserFacingError`s so the user is told what
 * to change rather than to "try again". Classification has to happen here,
 * before the error is flattened: the status code and response body live on
 * the AI SDK's `APICallError`.
 */
export function toProviderStreamError(
  error: unknown,
  context: ProviderContext,
): Error {
  const apiError = findApiCallError(error);
  const invalidKey = asInvalidApiKeyError(apiError ?? error, context.label);
  if (invalidKey) return invalidKey;
  const message = apiError && accessFailureMessage(apiError, context);
  const converted = message
    ? new UserFacingError(message)
    : error instanceof Error && error.message
      ? error
      : new Error(errorMessage(error, context.label));
  if (apiError && isTransientStatus(apiError)) retryable.add(converted);
  return converted;
}

// Failures another model can plausibly serve: the provider is overloaded,
// rate-limited or erroring, not the request or the account. A 429 carrying
// "limit: 0" is a plan that excludes the model — also worth another model.
// Recorded here because the status code is gone once the error is converted.
const retryable = new WeakSet<Error>();

function isTransientStatus({ statusCode }: ApiCallErrorLike): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/**
 * Whether a converted provider error may be retried on a different model.
 * Used by Assistant modes to walk a tier's fallback chain; a manually chosen
 * model never falls back, since the person asked for that model by name.
 */
export function isRetryableOnAnotherModel(error: unknown): boolean {
  return error instanceof Error && retryable.has(error);
}
