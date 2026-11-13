/**
 * Pushgateway resource — Prometheus pushgateway push API.
 *
 * Pushgateway is a Prometheus component that accepts metric pushes in
 * text-exposition format. Unlike the read-only Prometheus / Loki / Grafana
 * resources this module already exposes, pushgateway is a write surface and
 * does not use the API token — its URL is supplied per-call (env-resolved by
 * default to $PUSHGATEWAY_URL).
 */
import { INodeProperties } from "n8n-workflow";

import type { OperationFlags } from "./prometheus.resource";

export const pushgatewayOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  displayOptions: { show: { resource: ["pushgateway"] } },
  options: [
    {
      name: "Push Metric",
      value: "pushMetric",
      action: "Push one or more metrics to a Prometheus pushgateway",
      description:
        "POST metrics in Prometheus text-exposition format to {pushgatewayUrl}/metrics/job/{job}/{label}/{value}/...",
    },
  ],
  default: "pushMetric",
};

export const pushgatewayOperationFlags: Record<string, OperationFlags> = {
  pushMetric: { write: true, idempotent: true },
};

export const pushgatewayFields: INodeProperties[] = [
  {
    displayName: "Pushgateway URL",
    name: "pushgatewayUrl",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["pushgateway"], operation: ["pushMetric"] } },
    default: "={{$env.PUSHGATEWAY_URL}}",
    description:
      "Base URL of the pushgateway (no trailing slash). Defaults to the PUSHGATEWAY_URL env-var env var.",
  },
  {
    displayName: "Job",
    name: "job",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["pushgateway"], operation: ["pushMetric"] } },
    default: "",
    placeholder: "improve_workflow_qa",
    description: "Pushgateway `job` label — first URL path segment after /metrics/job/.",
  },
  {
    displayName: "Grouping Labels",
    name: "labelPairs",
    type: "fixedCollection",
    placeholder: "Add Label",
    typeOptions: { multipleValues: true },
    displayOptions: { show: { resource: ["pushgateway"], operation: ["pushMetric"] } },
    default: {},
    description:
      "Additional grouping labels appended to the URL as /key/value/ path segments (pushgateway grouping-key convention).",
    options: [
      {
        name: "label",
        displayName: "Label",
        values: [
          { displayName: "Name", name: "name", type: "string", default: "" },
          { displayName: "Value", name: "value", type: "string", default: "" },
        ],
      },
    ],
  },
  {
    displayName: "Metrics",
    name: "metrics",
    type: "fixedCollection",
    placeholder: "Add Metric",
    typeOptions: { multipleValues: true },
    required: false,
    displayOptions: { show: { resource: ["pushgateway"], operation: ["pushMetric"] } },
    default: { metric: [{ name: "cron_last_success_seconds", value: "={{ Math.floor(Date.now()/1000) }}", type: "gauge", help: "" }] },
    description: "Metrics to push. Each becomes a line in the Prometheus text-exposition body.",
    options: [
      {
        name: "metric",
        displayName: "Metric",
        values: [
          { displayName: "Name", name: "name", type: "string", required: false, default: "" },
          {
            displayName: "Value",
            name: "value",
            type: "string",
            required: false,
            default: "",
            placeholder: "={{ Math.floor(Date.now()/1000) }}",
            description: "Numeric value or an expression that resolves to a number.",
          },
          {
            displayName: "Type",
            name: "type",
            type: "options",
            default: "gauge",
            options: [
              { name: "Counter", value: "counter" },
              { name: "Gauge", value: "gauge" },
              { name: "Histogram", value: "histogram" },
              { name: "Summary", value: "summary" },
            ],
            description: "Prometheus metric type. Emitted as a `# TYPE` line.",
          },
          {
            displayName: "Help",
            name: "help",
            type: "string",
            default: "",
            description: "Optional documentation string. Emitted as a `# HELP` line when non-empty.",
          },
        ],
      },
    ],
  },
];
