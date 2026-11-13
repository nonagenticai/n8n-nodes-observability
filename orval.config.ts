export default {
  "observability": {
    "input": "docs/openapi.json",
    "output": {
      "target": "./src/generated/api-client.ts",
      "client": "axios",
      "mode": "single",
      "schemas": "./src/generated/models",
      "override": {
        "mutator": {
          "path": "./src/generated/mutator.ts",
          "name": "customInstance"
        }
      }
    }
  }
};
