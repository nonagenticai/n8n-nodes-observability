import type {
  ICredentialDataDecryptedObject,
  ICredentialType,
  IHttpRequestOptions,
  INodeProperties,
} from "n8n-workflow";

/**
 * Service URL resolution.
 *
 * Service addresses come from the deployment environment, not from code-side
 * fallbacks: empty string is the only fallback, and production deployments are
 * validated by `validateProductionConfig()` below, which fails loudly if the
 * required URL is missing.
 *
 * The credential UI-level `baseUrl` override still takes precedence at runtime;
 * the env var exported here is the deployment-wide default.
 */
export const OBSERVABILITY_API_URL = process.env.OBSERVABILITY_API_URL || "";

/**
 * Startup-time validator for production-only invariants.
 *
 * In `NODE_ENV=production` (or `N8N_ENV=production`), `OBSERVABILITY_API_URL`
 * must be set in the supplied env (defaults to `process.env`). Throws when
 * missing, so a misconfigured deployment crashes loudly on first invocation
 * rather than silently routing to a dead host.
 *
 * @throws Error when OBSERVABILITY_API_URL is unset and the runtime is production.
 */
export function validateProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const runtime = env.NODE_ENV || env.N8N_ENV || "development";
  if (runtime !== "production") return;
  if (!env.OBSERVABILITY_API_URL) {
    throw new Error(
      `[@nonagenticai/n8n-nodes-observability] Missing required env var in ` +
        `production: OBSERVABILITY_API_URL. Set it in the n8n deployment manifest ` +
        `and redeploy.`,
    );
  }
}

export class ObservabilityApi implements ICredentialType {
  name = "observabilityApi";
  displayName = "Observability Node APIs API";
  icon = "file:observability.svg" as const;

  properties: INodeProperties[] = [
    // ⛔ THIS NODE FRONTS THREE DIFFERENT BACKENDS. It needs three URLs.
    //
    // It used to declare exactly one, `baseUrl`, and every handler was handed
    // it — so all five Loki READ operations and all five Grafana operations were
    // sent to whatever `baseUrl` named. A Loki query asked Prometheus for
    // `/loki/api/v1/query` and a dashboard search asked Prometheus for
    // `/api/search`. The two Loki WRITE ops escaped only because someone had
    // already bolted a per-node `lokiUrl` parameter onto them — the workaround
    // that should have been the signal.
    //
    // Fixed at the CREDENTIAL rather than as node parameters for two reasons:
    // `LOKI_URL`/`GRAFANA_URL` are often unset, so a `={{$env.LOKI_URL}}` default
    // resolves empty, and Grafana's API requires authentication — `/api/search`
    // returns 401 while only `/api/health` is anonymous — which a node parameter
    // cannot carry and a credential can.
    {
      displayName: "Prometheus URL",
      name: "prometheusUrl",
      type: "string",
      default: "",
      required: false,
      placeholder: "http://localhost:9090",
      description:
        "Base URL for the prometheus resource. Falls back to Base URL, which is what that field has always meant in practice.",
    },
    {
      displayName: "Loki URL",
      name: "lokiUrl",
      type: "string",
      default: "",
      required: false,
      placeholder: "http://localhost:3100",
      description:
        "Base URL for the loki resource READ operations. Required for them; there is deliberately NO fallback to Base URL, because that silent fallback is precisely the defect this field exists to remove.",
    },
    {
      displayName: "Grafana URL",
      name: "grafanaUrl",
      type: "string",
      default: "",
      required: false,
      placeholder: "http://localhost:3000",
      description:
        "Base URL for the grafana resource. Required for it; no fallback to Base URL, for the same reason as Loki URL.",
    },
    {
      displayName: "Grafana API Key",
      name: "grafanaApiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: false,
      description:
        "Grafana service-account token or 'user:password' for basic auth. Grafana's API is authenticated (only /api/health is anonymous), so without this the grafana resource returns 401. Sent INSTEAD of the API token, which Grafana does not understand.",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "",
      required: false,
      placeholder: "http://localhost:9090",
      description:
        "Legacy single base URL. Now the fallback for Prometheus URL only — it never meant anything else, it was just handed to every resource.",
    },
    {
      displayName: "API Token",
      name: "apiToken",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: false,
      description:
        "Optional bearer token sent to the backend that owns the resource. Leave empty for an unauthenticated Prometheus, Loki or Pushgateway; Grafana uses its own API key instead.",
    },
    {
      displayName: "Tenant ID",
      name: "tenantId",
      type: "string",
      default: "",
      required: false,
      description:
        "Optional X-Tenant-ID header for a multi-tenant gateway. Leave EMPTY to omit the header; set it only when the service in front of the backend needs an explicit tenant.",
    },
  ];

  // ⛔ Deliberately NO `test` here. A function-valued ICredentialType.test is never
  // invoked by n8n (CredentialsTester wraps it as `{ testRequest: type.test }` and
  // routes `.request` off a function, i.e. undefined). This module's test is
  // IMPERATIVE — three backends, three URLs, per-backend reporting — so it lives on
  // the NODE as `methods.credentialTest.observabilityApiTest`, referenced by
  // `testedBy` on the node's credential declaration.

  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    if (!requestOptions.headers) {
      requestOptions.headers = {};
    }
    if (credentials.apiToken) {
      requestOptions.headers["Authorization"] = `Bearer ${credentials.apiToken}`;
    }
    if (credentials.tenantId) {
      requestOptions.headers["X-Tenant-ID"] = credentials.tenantId as string;
    }
    return requestOptions;
  }
}
