/**
 * Metering resource — read metering gauges directly from a metering
 * service's Prometheus text-exposition `/metrics` endpoint.
 *
 * WHY THIS EXISTS: some deployments expose per-asset quality gauges only
 * through a service's own `/metrics`, not through Prometheus. Reading
 * `/metrics` directly and reshaping the matching gauge family into the SAME
 * Prometheus instant-query vector envelope the `prometheus` resource returns
 * keeps consumers (which parse `data.result[].metric` / `.value[1]`) unchanged.
 *
 * The selectors used here are bare instant selectors with no PromQL functions
 * (`metric_name{asset_kind="x"}`), so reading the current gauge off `/metrics`
 * is equivalent to an instant query.
 *
 * Like `pushgateway`, this resource does NOT use the API token — `/metrics` is
 * normally an unauthenticated endpoint and its URL is supplied per-call
 * (env-resolved by default to $METERING_API_URL).
 */
import { INodeProperties } from "n8n-workflow";

import type { OperationFlags } from "./prometheus.resource";

export const meteringOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  displayOptions: { show: { resource: ["metering"] } },
  options: [
    {
      name: "Instant Query",
      value: "meteringInstantQuery",
      action: "Read a metering gauge family as a Prometheus vector",
      description:
        "Fetch {meteringUrl}/metrics and return one gauge family as a Prometheus instant-query vector envelope (data.result[]).",
    },
  ],
  default: "meteringInstantQuery",
};

/** Replay-safety hints keyed by operation value. */
export const meteringOperationFlags: Record<string, OperationFlags> = {
  meteringInstantQuery: { read: true, idempotent: true },
};

export const meteringFields: INodeProperties[] = [
  {
    displayName: "Metering URL",
    name: "meteringUrl",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["metering"], operation: ["meteringInstantQuery"] } },
    default: "={{$env.METERING_API_URL}}",
    placeholder: "http://localhost:8156",
    description:
      "Base URL of the metering service (no trailing slash). `/metrics` is appended. Defaults to the METERING_API_URL env var.",
  },
  {
    displayName: "Metric Name",
    name: "metricName",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["metering"], operation: ["meteringInstantQuery"] } },
    default: "",
    placeholder: "metering_exec_quality_avg_score",
    description:
      "Bare Prometheus series name to extract from /metrics (e.g. metering_exec_quality_avg_score).",
  },
  {
    displayName: "Asset Kind",
    name: "assetKind",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["metering"], operation: ["meteringInstantQuery"] } },
    default: "",
    placeholder: "prompt",
    description:
      "Optional. When set, only series whose `asset_kind` label equals this value are returned. Empty = all series for the metric.",
  },
];
