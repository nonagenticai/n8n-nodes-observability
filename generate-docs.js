#!/usr/bin/env node

/**
 * Documentation Generator for Observability Node
 *
 * Generates comprehensive documentation from:
 * - TypeScript source files
 * - OpenAPI specification
 * - Package.json metadata
 *
 * Outputs:
 * - docs/GENERATED_REFERENCE.md - Auto-generated reference
 * - docs/node-reference.json - Machine-readable node metadata
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  packageJson: './package.json',
  openApiSpec: './docs/openapi.json',
  nodeFile: './nodes/Observability/Observability.node.ts',
  credentialFile: './credentials/ObservabilityApi.credentials.ts',
  outputDir: './docs',
  outputs: {
    reference: './docs/GENERATED_REFERENCE.md',
    json: './docs/node-reference.json'
  }
};

/**
 * Main documentation generation function
 */
async function generateDocumentation() {
  console.log('📚 Generating documentation for Observability Node...\n');

  try {
    // 1. Load source data
    console.log('📖 Loading source files...');
    const packageData = loadJsonFile(CONFIG.packageJson);
    const openApiData = loadJsonFile(CONFIG.openApiSpec);

    // 2. Extract metadata
    console.log('🔍 Extracting metadata...');
    const metadata = extractMetadata(packageData, openApiData);

    // 3. Generate documentation
    console.log('✍️  Generating documentation files...');
    generateMarkdownReference(metadata);
    generateJsonReference(metadata);

    // 4. Summary
    console.log('\n✅ Documentation generation complete!\n');
    console.log('Generated files:');
    console.log(`  - ${CONFIG.outputs.reference}`);
    console.log(`  - ${CONFIG.outputs.json}`);
    console.log('');

  } catch (error) {
    console.error('❌ Error generating documentation:', error.message);
    process.exit(1);
  }
}

/**
 * Load and parse JSON file
 */
function loadJsonFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load ${filePath}: ${error.message}`);
  }
}

/**
 * Extract metadata from source files
 */
function extractMetadata(packageData, openApiData) {
  const metadata = {
    // Package info
    name: packageData.name,
    version: packageData.version,
    description: packageData.description,

    // API info
    apiVersion: openApiData.info.version,
    apiTitle: openApiData.info.title,
    apiDescription: openApiData.info.description,

    // Operations by resource
    resources: extractResourceOperations(openApiData),

    // Operations
    operations: extractOperations(openApiData),

    // Endpoints
    endpoints: extractEndpoints(openApiData),

    // Authentication
    authentication: extractAuthenticationInfo(openApiData),

    // Schemas
    schemas: openApiData.components?.schemas || {},

    // Tags
    tags: openApiData.tags || [],

    // Timestamps
    generatedAt: new Date().toISOString()
  };

  return metadata;
}

/**
 * Extract operations grouped by resource (tag)
 */
function extractResourceOperations(openApiData) {
  const resources = {};

  Object.entries(openApiData.paths).forEach(([path, methods]) => {
    Object.entries(methods).forEach(([method, details]) => {
      if (method === 'get' || method === 'post' || method === 'put' || method === 'delete') {
        const tags = details.tags || ['Other'];
        tags.forEach(tag => {
          if (!resources[tag]) {
            resources[tag] = [];
          }
          resources[tag].push({
            operationId: details.operationId,
            method: method.toUpperCase(),
            path: path,
            summary: details.summary,
            description: details.description
          });
        });
      }
    });
  });

  return resources;
}

/**
 * Extract operations from OpenAPI spec
 */
function extractOperations(openApiData) {
  const operations = [];

  Object.entries(openApiData.paths).forEach(([path, methods]) => {
    Object.entries(methods).forEach(([method, details]) => {
      if (method === 'get' || method === 'post' || method === 'put' || method === 'delete') {
        operations.push({
          operationId: details.operationId,
          method: method.toUpperCase(),
          path: path,
          summary: details.summary,
          description: details.description,
          tags: details.tags || [],
          parameters: details.parameters || [],
          requestBody: details.requestBody,
          responses: details.responses
        });
      }
    });
  });

  return operations;
}

/**
 * Extract endpoint information
 */
function extractEndpoints(openApiData) {
  return Object.keys(openApiData.paths).map(path => ({
    path: path,
    methods: Object.keys(openApiData.paths[path]).filter(m =>
      ['get', 'post', 'put', 'delete', 'patch'].includes(m)
    ).map(m => m.toUpperCase())
  }));
}

/**
 * Extract authentication information
 */
function extractAuthenticationInfo(openApiData) {
  const auth = {
    methods: ['API Token (Bearer)', 'Grafana API Key'],
    headerName: 'Authorization',
    headerFormat: 'Bearer <token>'
  };

  // Check for security schemes in OpenAPI
  if (openApiData.components?.securitySchemes) {
    auth.schemes = openApiData.components.securitySchemes;
  }

  return auth;
}

/**
 * Generate Markdown reference documentation
 */
function generateMarkdownReference(metadata) {
  const content = `# Observability Node - Generated Reference

> **Auto-generated documentation** - Generated on ${new Date(metadata.generatedAt).toLocaleString()}
>
> This file is automatically generated from source code and OpenAPI specification.

## Package Information

- **Name**: ${metadata.name}
- **Version**: ${metadata.version}
- **Description**: ${metadata.description}

## Resources

The Observability node provides access to three observability platforms:

${generateResourcesOverview(metadata.tags)}

## Operations by Resource

${generateResourceOperationsMarkdown(metadata.resources)}

## All Operations

${generateOperationsMarkdown(metadata.operations)}

## Endpoints

${generateEndpointsMarkdown(metadata.endpoints)}

## Authentication

${generateAuthenticationMarkdown(metadata.authentication)}

## Data Schemas

${generateSchemasMarkdown(metadata.schemas)}

---

**Generated**: ${metadata.generatedAt}

`;

  fs.writeFileSync(CONFIG.outputs.reference, content);
}

/**
 * Generate resources overview
 */
function generateResourcesOverview(tags) {
  if (!tags || tags.length === 0) {
    return 'No resources defined.';
  }

  return tags.map(tag => `
### ${tag.name}

${tag.description || 'No description provided'}
`).join('\n');
}

/**
 * Generate operations by resource in Markdown
 */
function generateResourceOperationsMarkdown(resources) {
  return Object.entries(resources).map(([resource, ops]) => `
### ${resource}

| Operation | Method | Path |
|-----------|--------|------|
${ops.map(op => `| ${op.summary || op.operationId} | \`${op.method}\` | \`${op.path}\` |`).join('\n')}

`).join('\n');
}

/**
 * Generate operations section in Markdown
 */
function generateOperationsMarkdown(operations) {
  if (operations.length === 0) {
    return 'No operations found.';
  }

  return operations.map(op => `
### ${op.summary || op.operationId}

- **Operation ID**: \`${op.operationId}\`
- **Method**: \`${op.method}\`
- **Path**: \`${op.path}\`
- **Tags**: ${op.tags.join(', ') || 'None'}
- **Description**: ${op.description || 'No description provided'}

${op.parameters.length > 0 ? `
**Parameters**:
${op.parameters.map(p => `- \`${p.name}\` (${p.in}): ${p.description || 'No description'}`).join('\n')}
` : ''}

${op.requestBody ? `
**Request Body**: ${op.requestBody.required ? 'Required' : 'Optional'}
` : ''}

**Responses**:
${Object.entries(op.responses).map(([code, resp]) => `- \`${code}\`: ${resp.description || 'No description'}`).join('\n')}

`).join('\n---\n');
}

/**
 * Generate endpoints section in Markdown
 */
function generateEndpointsMarkdown(endpoints) {
  return `
| Endpoint | Methods |
|----------|---------|
${endpoints.map(ep => `| \`${ep.path}\` | ${ep.methods.join(', ')} |`).join('\n')}
`;
}

/**
 * Generate authentication section in Markdown
 */
function generateAuthenticationMarkdown(auth) {
  return `
### Supported Methods

${auth.methods.map(m => `- ${m}`).join('\n')}

### Header Format

- **Header**: \`${auth.headerName}\`
- **Format**: \`${auth.headerFormat}\`

### Credentials

The node requires ObservabilityApi credentials with:
- **API Token**: Optional bearer for a gateway in front of the backend
- **Prometheus URL**: Prometheus server endpoint
- **Loki URL**: Loki server endpoint
- **Grafana URL**: Grafana server endpoint
- **Grafana API Key**: Optional, for Grafana operations

${auth.schemes ? `
### Security Schemes

\`\`\`json
${JSON.stringify(auth.schemes, null, 2)}
\`\`\`
` : ''}
`;
}

/**
 * Generate schemas section in Markdown
 */
function generateSchemasMarkdown(schemas) {
  if (Object.keys(schemas).length === 0) {
    return 'No schemas defined.';
  }

  return Object.entries(schemas).map(([name, schema]) => `
### ${name}

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`
`).join('\n');
}

/**
 * Generate JSON reference file
 */
function generateJsonReference(metadata) {
  const jsonContent = {
    package: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description
    },
    api: {
      version: metadata.apiVersion,
      title: metadata.apiTitle,
      description: metadata.apiDescription
    },
    resources: Object.keys(metadata.resources),
    operations: metadata.operations.map(op => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      summary: op.summary,
      description: op.description,
      tags: op.tags,
      parametersCount: op.parameters.length,
      hasRequestBody: !!op.requestBody,
      responseCodes: Object.keys(op.responses)
    })),
    endpoints: metadata.endpoints,
    authentication: metadata.authentication,
    schemas: Object.keys(metadata.schemas),
    generatedAt: metadata.generatedAt,
    generator: {
      name: 'generate-docs.js',
      version: '1.0.0'
    }
  };

  fs.writeFileSync(
    CONFIG.outputs.json,
    JSON.stringify(jsonContent, null, 2)
  );
}

/**
 * Check if required files exist
 */
function validateSetup() {
  const requiredFiles = [
    CONFIG.packageJson,
    CONFIG.openApiSpec
  ];

  const missing = requiredFiles.filter(file => !fs.existsSync(file));

  if (missing.length > 0) {
    console.error('❌ Missing required files:');
    missing.forEach(file => console.error(`   - ${file}`));
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
}

/**
 * CLI entry point
 */
if (require.main === module) {
  validateSetup();
  generateDocumentation().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  generateDocumentation,
  extractMetadata,
  extractOperations
};
