import type {
  HealthCheckExecutionRepository
} from "../db/health-check-repository.js";

import {
  checkEndpointHealth,
  type HealthCheckResult
} from "./check-endpoint.js";

export type HealthCheckExecutionErrorCode =
  | "invalid_endpoint_id"
  | "endpoint_not_found"
  | "endpoint_disabled";

export class HealthCheckExecutionError extends Error {
  constructor(
    public readonly code: HealthCheckExecutionErrorCode
  ) {
    super(code);
    this.name = "HealthCheckExecutionError";
  }
}

export interface ExecuteHealthCheckDependencies {
  repository: HealthCheckExecutionRepository;

  // Injectable so unit tests do not need real network requests.
  checkEndpoint: (
    url: string
  ) => Promise<HealthCheckResult>;
}

/**
 * Executes one health check for an existing, enabled endpoint.
 *
 * A completed unhealthy check is persisted just like a healthy check.
 * Repository failures propagate to the caller.
 */
export async function executeHealthCheck(
  endpointId: number,
  dependencies: ExecuteHealthCheckDependencies
) {
  if (!Number.isSafeInteger(endpointId) || endpointId <= 0) {
    throw new HealthCheckExecutionError("invalid_endpoint_id");
  }

  const endpoint =
    await dependencies.repository.findEndpointById(endpointId);

  if (!endpoint) {
    throw new HealthCheckExecutionError("endpoint_not_found");
  }

  if (!endpoint.enabled) {
    throw new HealthCheckExecutionError("endpoint_disabled");
  }

  // Reuse the existing security-hardened HTTP checker.
  const observation = await dependencies.checkEndpoint(endpoint.url);

  // Persist both healthy and unhealthy observations.
  // Let database failures propagate rather than reporting false success.
  return dependencies.repository.saveResult({
    endpointId: endpoint.id,
    outcome: observation.outcome,
    httpStatus: observation.httpStatus,
    latencyMs: observation.latencyMs,
    failureCode: observation.failureCode
  });
}

/**
 * Convenience wrapper for production callers that want the real checker.
 */
export function executeHealthCheckWithRealChecker(
  endpointId: number,
  repository: HealthCheckExecutionRepository
) {
  return executeHealthCheck(endpointId, {
    repository,
    checkEndpoint: checkEndpointHealth
  });
}