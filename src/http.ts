import { randomUUID } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { getMcpServer } from './mcp-server.js'

// Load environment variables from .env file
dotenv.config()

const app = express()
app.use(express.json())

// Configure CORS
app.use(
    cors({
        origin: '*', // Allow any origin
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id'],
    }),
)

// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

// Handle POST requests for client-to-server communication
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId]
    } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
                // Store the transport by session ID
                transports[sessionId] = transport
            },
        })

        // Clean up transport when closed
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId]
            }
        }

        const todoistApiKey = process.env.TODOIST_API_KEY
        if (!todoistApiKey) {
            // We use console.error because we can't send a response to a request that doesn't have a session yet.
            console.error('TODOIST_API_KEY is not set')
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Internal Server Error: TODOIST_API_KEY is not set',
                },
                id: null,
            })
            return
        }

        const server = getMcpServer({ todoistApiKey })

        // Connect to the MCP server
        await server.connect(transport)
    } else {
        // Invalid request
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: No valid session ID provided',
            },
            id: null,
        })
        return
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body)
})

// Reusable handler for GET and DELETE requests
const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
    }

    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
}

// Handle GET requests for server-to-client notifications via SSE
app.get('/mcp', handleSessionRequest)

// Handle DELETE requests for session termination
app.delete('/mcp', handleSessionRequest)

const port = process.env.PORT || 8080

app.listen(port, () => {
    console.log(`MCP server listening on port ${port}`)
})
