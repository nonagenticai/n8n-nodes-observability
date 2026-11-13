/**
 * Prometheus resource — operation and field definitions.
 */
import { INodeProperties } from "n8n-workflow";

/** Per-operation replay-safety hints (read / idempotent flags). */
export type OperationFlags = {
  read?: boolean;
  write?: boolean;
  idempotent?: boolean;
};

export const prometheusOperations: INodeProperties = {
  displayName: "Operation",
  name: "operation",
  type: "options",
  displayOptions: { show: { resource: ["prometheus"] } },
  options: [
    {
      name: "Prometheus Instant Query",
      value: "prometheusInstantQuery",
      action: "Prometheus instant query",
      description: "Instant Query",
    },
    {
      name: "Prometheus Range Query",
      value: "prometheusRangeQuery",
      action: "Prometheus range query",
      description: "Range Query",
    },
    {
      name: "Prometheus Get Targets",
      value: "prometheusGetTargets",
      action: "Prometheus get targets",
      description: "Get Targets",
    },
    {
      name: "Prometheus Get Alerts",
      value: "prometheusGetAlerts",
      action: "Prometheus get alerts",
      description: "Get Alerts",
    },
    {
      name: "Prometheus Get Rules",
      value: "prometheusGetRules",
      action: "Prometheus get rules",
      description: "Get Rules",
    },
    {
      name: "Prometheus Get Metric Names",
      value: "prometheusGetMetricNames",
      action: "Prometheus get metric names",
      description: "Get Metric Names",
    },
    {
      name: "Prometheus Get Series",
      value: "prometheusGetSeries",
      action: "Prometheus get series",
      description: "Get Series",
    },
    {
      name: "Prometheus Get Metadata",
      value: "prometheusGetMetadata",
      action: "Prometheus get metadata",
      description: "Get Metadata",
    },
    // Hand-added: the declarative description already lists this write op, but
    // it was never emitted into the resources/ + operations/ path the node
    // actually executes. Added by hand alongside the operations/index.ts handler.
    {
      name: "Push Metrics (OTLP)",
      value: "pushMetricsOTLP",
      action: "Push metrics via OTLP",
      description: "Push metrics to an OTLP/HTTP receiver",
    },
  ],
  default: "prometheusInstantQuery",
};

/** Replay-safety hints keyed by operation value. */
export const prometheusOperationFlags: Record<string, OperationFlags> = {
  prometheusInstantQuery: {"read":true,"idempotent":true},
  prometheusRangeQuery: {"read":true,"idempotent":true},
  prometheusGetTargets: {"read":true,"idempotent":true},
  prometheusGetAlerts: {"read":true,"idempotent":true},
  prometheusGetRules: {"read":true,"idempotent":true},
  prometheusGetMetricNames: {"read":true,"idempotent":true},
  prometheusGetSeries: {"read":true,"idempotent":true},
  prometheusGetMetadata: {"read":true,"idempotent":true},
  // Pushing metrics is a write; not idempotent (each push is a distinct sample).
  pushMetricsOTLP: {"write":true},
};

export const prometheusFields: INodeProperties[] = [
  // ⛔ THESE ARE TOP-LEVEL ON PURPOSE — do not move them back into a collection.
  //
  // Until 2026-08-27 every property below lived inside an `additionalOptions`
  // collection, while `operations/index.ts` reads each of them by BARE TOP-LEVEL
  // NAME (`getParam("query")`). n8n normalises `node.parameters` against these
  // properties before a handler runs and keeps only what is declared AT THE
  // POSITION it was written, so a collection child is not a top-level key and every
  // one of these reads returned its default. The result: instant queries, range
  // queries, series selectors and metadata lookups all went out with NO PARAMETERS
  // and came back with a plausible, unasked-for answer.
  //
  // The handlers are the intentional side of this — `operations/index.ts:1-11`
  // records that they were deliberately hand-patched off the `additionalOptions.`
  // prefix and warns that regenerating them reintroduces "the empty-query bug that
  // broke all Prometheus/Loki demos at v0.1.1". The descriptions were simply never
  // brought along. Pinned by `__tests__/description-handler-reconciliation.test.ts`,
  // which drives n8n's own `getNodeParameters` rather than re-checking the array.
  //
  // Each `operation` list below is exactly the set of ops whose `__qmap` in
  // `operations/index.ts` actually reads that name — a property shown for an
  // operation that never reads it is dead UI, and the gate's reverse leg fails on it.
  {
    displayName: "Query",
    name: "query",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusInstantQuery", "prometheusRangeQuery"] } },
    description: "PromQL query expression",
  },
  {
    displayName: "Time",
    name: "time",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusInstantQuery"] } },
    description: "Evaluation timestamp (Unix or RFC3339)",
  },
  {
    displayName: "Timeout",
    name: "timeout",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusInstantQuery", "prometheusRangeQuery"] } },
    description: "Query timeout",
  },
  {
    displayName: "Start",
    name: "start",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusRangeQuery"] } },
    description: "Start timestamp",
  },
  {
    displayName: "End",
    name: "end",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusRangeQuery"] } },
    description: "End timestamp",
  },
  {
    displayName: "Step",
    name: "step",
    type: "string",
    default: "15s",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusRangeQuery"] } },
    description: "Query resolution step width",
  },
  {
    displayName: "State",
    name: "state",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusGetTargets"] } },
    description: "Filter by target state (active, dropped, any)",
  },
  {
    displayName: "Type",
    name: "type",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusGetRules"] } },
    description: "Filter by rule type",
  },
  {
    // Declared `match`, sent as `match[]`. The property USED to be named `match[]`,
    // which no workflow could ever have addressed: `getNodeParameter` resolves
    // dotted/bracketed PATHS, so a literal `[`/`]` in a property name is unreachable
    // by construction. The handler already emits `match[]` as the wire name
    // (`operations/index.ts` __qmap `["match", "match[]", false]`), so the wire
    // contract is unchanged — only the name an author can actually type.
    displayName: "Match",
    name: "match",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusGetSeries"] } },
    description: "Series selector, e.g. {job=~\".+\"}",
  },
  {
    displayName: "Metric",
    name: "metric",
    type: "string",
    default: "",
    displayOptions: { show: { resource: ["prometheus"], operation: ["prometheusGetMetadata"] } },
    description: "Metric name filter",
  },
  // ---- Push Metrics (OTLP) fields (hand-added; see prometheusOperations note) ----
  {
    displayName: "OTLP Endpoint",
    name: "otlpEndpoint",
    type: "string",
    required: false,
    displayOptions: { show: { resource: ["prometheus"], operation: ["pushMetricsOTLP"] } },
    default: "http://localhost:4318",
    placeholder: "http://localhost:4318",
    description: "OTLP/HTTP endpoint. POSTs to <endpoint>/v1/metrics.",
  },
  {
    displayName: "Metrics",
    name: "metrics",
    type: "json",
    required: false,
    displayOptions: { show: { resource: ["prometheus"], operation: ["pushMetricsOTLP"] } },
    default: '{"metricValues": []}',
    placeholder: '{"metricValues":[{"name":"x_total","type":"counter","value":1,"labels":{"k":"v"}}]}',
    description:
      "Object with a metricValues array of {name, type (counter|gauge|histogram|sum), value, labels?, help?, unit?} entries. Accepts a JSON literal or an expression yielding the same shape.",
  },
  {
    displayName: "Resource Attributes",
    name: "resourceAttributes",
    type: "json",
    displayOptions: { show: { resource: ["prometheus"], operation: ["pushMetricsOTLP"] } },
    default: '{"service.name": "n8n-workflow"}',
    description: "OTLP resource attributes (e.g. service.name, service.namespace).",
  },
];
