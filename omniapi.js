#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';

class SimpleMCPServer {
  constructor() {
    this.server = new Server({
      name: 'omniapi',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {}
      }
    });

    this.apis = new Map();
    this.setupHandlers();
  }

  setupHandlers() {

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
        {
          name: 'add_api',
          description: 'Adds a new API for use. Just provide the API base URL or simply its name.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Name to identify this API'
              },
              baseUrl: {
                type: 'string',
                description: 'API base URL (e.g., https://api.example.com)'
              },
              headers: {
                type: 'object',
                description: 'Optional headers (e.g., Authorization)',
                additionalProperties: { type: 'string' }
              }
            },
            required: ['name', 'baseUrl']
          }
        },
        {
          name: 'list_apis',
          description: 'Lists all configured APIs',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'call_api',
          description: 'Makes a request to any configured API',
          inputSchema: {
            type: 'object',
            properties: {
              api: {
                type: 'string',
                description: 'Name of the configured API'
              },
              endpoint: {
                type: 'string',
                description: 'API endpoint (e.g., /users, /posts/1)'
              },
              method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                default: 'GET',
                description: 'HTTP method'
              },
              body: {
                type: 'object',
                description: 'Data to send in the body (for POST/PUT/PATCH)'
              },
              params: {
                type: 'object',
                description: 'Query parameters',
                additionalProperties: { type: 'string' }
              }
            },
            required: ['api', 'endpoint']
          }
        },
        {
          name: 'discover_api',
          description: 'Attempts to discover available endpoints in an API (works with APIs that have OpenAPI documentation)',
          inputSchema: {
            type: 'object',
            properties: {
              api: {
                type: 'string',
                description: 'Name of the configured API'
              }
            },
            required: ['api']
          }
        }
      ];

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'add_api':
            return await this.addApi(args);

          case 'list_apis':
            return await this.listApis();

          case 'call_api':
            return await this.callApi(args);

          case 'discover_api':
            return await this.discoverApi(args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`
          }],
          isError: true
        };
      }
    });
  }

  async addApi(args) {
    const { name, baseUrl, headers = {} } = args;

    // Remove trailing slashes from URL
    const cleanUrl = baseUrl.replace(/\/+$/, '');

    this.apis.set(name, {
      baseUrl: cleanUrl,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    });

    return {
      content: [{
        type: 'text',
        text: `✅ API "${name}" added successfully!\nURL: ${cleanUrl}\n\nYou can now use:\n- call_api to make calls\n- discover_api to discover endpoints`
      }]
    };
  }

  async listApis() {
    if (this.apis.size === 0) {
      return {
        content: [{
          type: 'text',
          text: '📝 No APIs configured yet.\n\nUse add_api to add an API.'
        }]
      };
    }

    const apiList = Array.from(this.apis.entries())
      .map(([name, config]) => `• ${name}: ${config.baseUrl}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `📋 Configured APIs:\n\n${apiList}`
      }]
    };
  }

  async callApi(args) {
    const { api, endpoint, method = 'GET', body, params } = args;

    if (!this.apis.has(api)) {
      throw new Error(`API "${api}" not found. Use list_apis to see available APIs.`);
    }

    const apiConfig = this.apis.get(api);

    // Build the URL
    let url = `${apiConfig.baseUrl}${endpoint.startsWith('/') ? endpoint : '/' + endpoint}`;

    // Add query parameters
    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const fetchOptions = {
      method,
      headers: apiConfig.headers
    };

    // Add body if needed
    if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();

    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    const result = {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      data: responseData
    };

    return {
      content: [{
        type: 'text',
        text: `🌐 Response from API "${api}":\n\n${JSON.stringify(result, null, 2)}`
      }]
    };
  }

  async discoverApi(args) {
    const { api } = args;

    if (!this.apis.has(api)) {
      throw new Error(`API "${api}" not found.`);
    }

    const apiConfig = this.apis.get(api);
    const commonPaths = [
      '/swagger.json',
      '/openapi.json',
      '/api-docs',
      '/docs',
      '/swagger/v1/swagger.json',
      '/v1/swagger.json',
      '/.well-known/openapi.json'
    ];

    let discovered = `🔍 Trying to discover endpoints for API "${api}"...\n\n`;

    // Try to find OpenAPI documentation
    for (const path of commonPaths) {
      try {
        const response = await fetch(`${apiConfig.baseUrl}${path}`, {
          headers: apiConfig.headers
        });

        if (response.ok) {
          const doc = await response.json();
          if (doc.paths || doc.swagger || doc.openapi) {
            discovered += `✅ Documentation found at: ${path}\n\n`;

            if (doc.paths) {
              discovered += '📋 Available endpoints:\n';
              Object.keys(doc.paths).forEach(endpoint => {
                const methods = Object.keys(doc.paths[endpoint]).join(', ').toUpperCase();
                discovered += `• ${endpoint} [${methods}]\n`;
              });
            }

            return {
              content: [{
                type: 'text',
                text: discovered
              }]
            };
          }
        }
      } catch (error) {
        // Silently continue to next path
      }
    }

    discovered += '❌ OpenAPI documentation not found.\n\n';
    discovered += '🔍 Testing common endpoints...\n\n';

    const commonEndpoints = ['/', '/api', '/health', '/status', '/users', '/posts'];

    for (const endpoint of commonEndpoints) {
      try {
        const response = await fetch(`${apiConfig.baseUrl}${endpoint}`, {
          method: 'HEAD',
          headers: apiConfig.headers
        });

        if (response.ok) {
          discovered += `✅ ${endpoint} (${response.status})\n`;
        }
      } catch (error) {
        // Silently continue to next endpoint
      }
    }

    return {
      content: [{
        type: 'text',
        text: discovered + '\n💡 Tip: Check the API documentation for specific endpoints.'
      }]
    };
  }

  async start() {
    console.error('🔧 Setting up transport...');
    const transport = new StdioServerTransport();

    console.error('🔗 Connecting to server...');
    await this.server.connect(transport);

    console.error('✅ OmniAPI MCP Server running!');
    console.error('📋 Available tools: add_api, list_apis, call_api, discover_api');

    process.stdin.resume();
  }
}

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught error:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejected:', reason);
  process.exit(1);
});

console.error('🚀 Starting OmniAPI MCP Server...');
console.error('📦 Node.js version:', process.version);
console.error('📁 Working directory:', process.cwd());

const server = new SimpleMCPServer();
server.start()
  .then(() => {
    console.error('✅ Server started successfully!');
  })
  .catch((error) => {
    console.error('❌ Error starting server:', error);
    process.exit(1);
  });