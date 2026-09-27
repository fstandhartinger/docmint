'use strict';

/**
 * The public /v1 API as a hand-written OpenAPI 3.1 document, served at
 * /openapi.json. Written from src/api.js (the actual router) and
 * src/api.js's helpers (capabilities.js, billing endpoints under /billing/*).
 *
 * Serves the same purpose the /docs page serves for humans, but in a form a
 * machine can consume: client generators, IDE plugins, registries, and
 * launch directories that ask for an OpenAPI document.
 *
 * This file is intentional duplication — it is NOT derived from the express
 * router. test/openapi.test.js asserts every path documented here exists in
 * the router and vice versa so drift has to be justified, not sneaked in.
 *
 * Conventions:
 *   - `servers` carries the /v1 prefix; every path entry uses the router's
 *     `:param` rewritten as `{param}` so URLs resolve correctly.
 *   - Error envelopes: all errors are one JSON object `{ error: { code, message, hint?, docs? } }`.
 *   - API-key auth: `Authorization: Bearer dm_live_*`; X-API-Key is accepted as fallback.
 */

const opSecurity = [{ apiKey: [] }];

const schemaRef = (name) => ({ $ref: `#/components/schemas/${name}` });

const errorResponse = (description, codes) => ({
  description: `${description} The error envelope lists a stable \`code\`. Most frequent for this operation: ${codes.map((c) => `\`${c}\``).join(', ')}.`,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
    },
  },
});

const requestIdHeaders = {
  'x-docmint-request-id': {
    schema: { type: 'string', example: 'dm_o9shbTxzJCqW' },
    description: 'Stable request id; include it in any support mail.',
  },
};

const creditHeaders = {
  'x-docmint-credits-remaining': {
    schema: { type: 'integer' },
    description: 'Remaining credits this month, after the operation.',
  },
};

const jsonContent = (schema) => ({ 'application/json': { schema } });
const binaryContent = (contentType) => ({ [contentType]: { schema: { type: 'string', format: 'binary' } } });

const binaryOrJson = (binaryType, description) => ({
  description: `${description} Response body is either the generated binary or a JSON result when the request asked for JSON.`,
  content: { ...binaryContent('application/octet-stream'), ...jsonContent({ type: 'object' }) },
});

const renderRequest = {
  required: true,
  content: jsonContent(schemaRef('RenderRequest')),
};

const inspectRequest = {
  required: true,
  content: jsonContent({
    type: 'object',
    properties: {
      template: { type: 'string' },
      template_base64: { type: 'string' },
      template_version: { type: 'integer' },
      data: { type: 'object', additionalProperties: true },
    },
    oneOf: [{ required: ['template'] }, { required: ['template_base64'] }],
  }),
};

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'DocMint API',
    version: '1.0.0',
    description: `Render and inspect documents from templates. One credit renders a document, one extra credit converts it to PDF. The machine-readable twin of /docs.`,
    'x-docs': 'https://docmint.app.mintapis.com/docs',
  },
  servers: [{ url: 'https://docmint.app.mintapis.com/v1' }],
  tags: [
    { name: 'Render' },
    { name: 'Async jobs' },
    { name: 'Templates' },
    { name: 'Webhooks' },
    { name: 'Inspect' },
    { name: 'Account' },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API key',
        description: 'Send `Authorization: Bearer dm_live_…` (X-API-Key is accepted as well). Keys start with `dm_live_`.',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', example: 'missing_input' },
              message: { type: 'string' },
              hint: { type: 'string', description: 'What to change to make this request succeed.' },
              docs: { type: 'string', format: 'uri-reference', example: '/docs#render' },
            },
          },
        },
      },
      RenderRequest: {
        type: 'object',
        required: ['data'],
        properties: {
          template: { type: 'string', description: 'Name of an uploaded template. Alternative to template_base64.' },
          template_base64: { type: 'string', description: 'Base64-encoded template bytes. Alternative to `template`.' },
          template_version: { type: 'integer' },
          data: { type: 'object', additionalProperties: true },
          output: { type: 'string', enum: ['document', 'pdf', 'both'], default: 'document' },
          filename: { type: 'string' },
          locale: { type: 'string', example: 'en-US' },
          currency: { type: 'string', example: 'USD' },
          timezone: { type: 'string', example: 'Europe/Berlin' },
          onMissing: { type: 'string', enum: ['error', 'empty', 'keep'], default: 'error' },
          strictScope: { type: 'boolean', default: false },
          now: { type: 'string', format: 'date-time' },
          images: { type: 'object', additionalProperties: { type: 'string' } },
          response: { type: 'string', enum: ['json'] },
          pdf_password: { type: 'string' },
        },
      },
      BatchItem: {
        type: 'object',
        required: ['data'],
        properties: {
          data: { type: 'object', additionalProperties: true },
          images: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      RenderBatchRequest: {
        type: 'object',
        required: ['items'],
        properties: {
          template: { type: 'string' },
          template_base64: { type: 'string' },
          items: { type: 'array', items: schemaRef('BatchItem'), minItems: 1, maxItems: 1000 },
          output: { type: 'string', enum: ['document', 'pdf', 'both'], default: 'document' },
          onMissing: { type: 'string', enum: ['error', 'empty', 'keep'], default: 'error' },
          onError: { type: 'string', enum: ['fail', 'skip'], default: 'fail' },
        },
      },
      JobRequest: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['render', 'parse'] },
          input: { type: 'object', description: 'Operation-specific input.' },
          output: { type: 'string', enum: ['document', 'pdf', 'both'], default: 'document' },
          webhook: { type: 'string', description: 'Name of a registered webhook endpoint to ping on completion.' },
        },
      },
      TemplateUploadMultipart: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary', description: 'docx/azure-templater template.' },
          name: { type: 'string', description: 'Template name; new uploads re-use the existing name to overwrite.' },
        },
      },
      JobStatus: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
          input: { type: 'object' },
          result: { type: 'object', nullable: true },
          error: schemaRef('ErrorResponse'),
          created_at: { type: 'string', format: 'date-time' },
          finished_at: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
    responses: {
      Unauthorized: errorResponse('API key missing or invalid.', ['unauthorized', 'invalid_api_key']),
      Forbidden: errorResponse('Plan does not include this feature.', ['plan_required', 'forbidden']),
      PayloadTooLarge: errorResponse('Body above the configured byte limit.', ['payload_too_large']),
      QuotaExceeded: errorResponse('Monthly credit quota reached.', ['quota_exceeded']),
      NotFound: errorResponse('Resource not found.', ['not_found']),
      InternalError: errorResponse('Unexpected error.', ['internal_error']),
    },
  },
  security: opSecurity,
  paths: {
    '/render': {
      post: {
        tags: ['Render'],
        operationId: 'render',
        summary: 'Render a template once and stream the result.',
        requestBody: renderRequest,
        responses: {
          200: {
            description: 'Either the generated binary or a JSON result when `response: json`.',
            headers: { ...requestIdHeaders, ...creditHeaders },
            content: {
              ...binaryContent('application/octet-stream'),
              ...jsonContent({
                type: 'object',
                properties: {
                  document: { type: 'string', description: 'Base64 document when output=document and response=json.' },
                  pdf: { type: 'string', description: 'Base64 PDF when output=pdf and response=json.' },
                  request_id: { type: 'string' },
                },
              }),
            },
          },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
          401: { $ref: '#/components/responses/Unauthorized' },
          402: { $ref: '#/components/responses/QuotaExceeded' },
          404: { $ref: '#/components/responses/NotFound' },
          422: errorResponse('Template input invalid: unknown field, missing_input, missing_section, strict-scope violation.', ['unknown_field', 'missing_input', 'missing_section', 'invalid_field']),
          500: { $ref: '#/components/responses/InternalError' },
        },
      },
    },
    '/render/batch': {
      post: {
        tags: ['Render'],
        operationId: 'renderBatch',
        summary: 'Render the same template many times in one request.',
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('RenderBatchRequest')),
        },
        responses: {
          200: {
            description: 'Zip archive of the per-item outputs (binary) or a JSON manifest when response: json.',
            content: binaryContent('application/zip'),
          },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
          401: { $ref: '#/components/responses/Unauthorized' },
          402: { $ref: '#/components/responses/QuotaExceeded' },
          404: { $ref: '#/components/responses/NotFound' },
          422: errorResponse('Invalid per-item input or template error.', ['unknown_field', 'missing_input', 'invalid_field']),
        },
      },
    },
    '/jobs': {
      post: {
        tags: ['Async jobs'],
        operationId: 'createJob',
        summary: 'Start a long-running render or parse job.',
        requestBody: { required: true, content: jsonContent(schemaRef('JobRequest')) },
        responses: {
          201: { description: 'Created.', content: jsonContent(schemaRef('JobStatus')) },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
          401: { $ref: '#/components/responses/Unauthorized' },
          402: { $ref: '#/components/responses/QuotaExceeded' },
          422: errorResponse('Invalid job input.', ['invalid_input']),
        },
      },
      get: {
        tags: ['Async jobs'],
        operationId: 'listJobs',
        summary: 'List jobs for the authenticated account.',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          200: { description: 'Job list.', content: jsonContent({ type: 'object' }) },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/jobs/{id}': {
      get: {
        tags: ['Async jobs'],
        operationId: 'getJob',
        summary: 'Poll a single job.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Job status.', content: jsonContent(schemaRef('JobStatus')) },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/jobs/{id}/cancel': {
      post: {
        tags: ['Async jobs'],
        operationId: 'cancelJob',
        summary: 'Cancel a queued or running job.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Acknowledged.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/webhooks': {
      get: {
        tags: ['Webhooks'],
        operationId: 'listWebhooks',
        summary: 'List registered webhook endpoints.',
        responses: {
          200: { description: 'List.', content: jsonContent({ type: 'object' }) },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/inspect': {
      post: {
        tags: ['Inspect'],
        operationId: 'inspect',
        summary: 'Return the placeholder fields of a template.',
        requestBody: inspectRequest,
        responses: {
          200: { description: 'Field list with types and cardinality.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          422: errorResponse('Template invalid.', ['invalid_template']),
        },
      },
    },
    '/templates': {
      get: {
        tags: ['Templates'],
        operationId: 'listTemplates',
        summary: 'List templates.',
        responses: {
          200: { description: 'Template list.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Templates'],
        operationId: 'uploadTemplate',
        summary: 'Upload a template (multipart, field `file`, optional `name`).',
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: schemaRef('TemplateUploadMultipart') } },
        },
        responses: {
          201: { description: 'Uploaded.' },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
          401: { $ref: '#/components/responses/Unauthorized' },
          422: errorResponse('Template invalid.', ['invalid_template']),
        },
      },
    },
    '/templates/{name}': {
      get: {
        tags: ['Templates'],
        operationId: 'getTemplate',
        summary: 'Get template metadata.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Template.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        tags: ['Templates'],
        operationId: 'replaceTemplate',
        summary: 'Replace a template\'s bytes (multipart, like POST /templates).',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: schemaRef('TemplateUploadMultipart') } } },
        responses: {
          200: { description: 'Replaced.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
        },
      },
      delete: {
        tags: ['Templates'],
        operationId: 'deleteTemplate',
        summary: 'Delete a template and all its versions.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Deleted.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/templates/{name}/fields': {
      get: {
        tags: ['Templates'],
        operationId: 'templateFields',
        summary: 'List the placeholder fields of a named template.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Field list.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/templates/{name}/file': {
      get: {
        tags: ['Templates'],
        operationId: 'templateFile',
        summary: 'Download the template file.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Binary.', content: binaryContent('application/octet-stream') },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/templates/{name}/versions': {
      get: {
        tags: ['Templates'],
        operationId: 'templateVersions',
        summary: 'List template versions.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Version list.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/templates/{name}/rollback': {
      post: {
        tags: ['Templates'],
        operationId: 'rollbackTemplate',
        summary: 'Roll a template back to an earlier version.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: jsonContent({ type: 'object', required: ['version'], properties: { version: { type: 'integer' } } }),
        },
        responses: {
          200: { description: 'Rolled back.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/usage': {
      get: {
        tags: ['Account'],
        operationId: 'usage',
        summary: 'Current billing-period usage.',
        responses: {
          200: { description: 'Usage counters and plan info.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/capabilities': {
      get: {
        tags: ['Account'],
        operationId: 'capabilities',
        summary: 'Formatter names, PDF-password capability and image capabilities.',
        security: [],
        responses: {
          200: { description: 'Capabilities snapshot.' },
        },
      },
    },
    '/signup': {
      post: {
        tags: ['Account'],
        operationId: 'signup',
        summary: 'Create an account, mint the first API key.',
        security: [],
        requestBody: {
          required: true,
          content: jsonContent({
            type: 'object',
            required: ['email', 'password'],
            properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } },
          }),
        },
        responses: {
          201: { description: 'Created. Response carries the new API key.' },
          400: { $ref: '#/components/responses/PayloadTooLarge' },
          409: errorResponse('User already exists.', ['user_exists']),
          422: errorResponse('Invalid input.', ['invalid_input', 'weak_password']),
        },
      },
    },
    '/billing/checkout': {
      post: {
        tags: ['Account'],
        operationId: 'billingCheckout',
        summary: 'Create a Stripe Checkout session.',
        responses: {
          200: { description: 'Checkout URL.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/billing/portal': {
      post: {
        tags: ['Account'],
        operationId: 'billingPortal',
        summary: 'Create a Stripe Customer-Portal session.',
        responses: {
          200: { description: 'Portal URL.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/billing/plans': {
      get: {
        tags: ['Account'],
        operationId: 'billingPlans',
        summary: 'List billing plans.',
        security: [],
        responses: {
          200: { description: 'Plan list.' },
        },
      },
    },
    '/keys': {
      get: {
        tags: ['Account'],
        operationId: 'listKeys',
        summary: 'List API keys for the account.',
        responses: {
          200: { description: 'Key list.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
      post: {
        tags: ['Account'],
        operationId: 'createKey',
        summary: 'Mint a new API key.',
        responses: {
          201: { description: 'New key.' },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
    '/keys/{prefix}': {
      delete: {
        tags: ['Account'],
        operationId: 'revokeKey',
        summary: 'Revoke an API key by prefix.',
        parameters: [{ name: 'prefix', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Revoked.' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
  },
};

module.exports = spec;
