# Scenario: Memory Leak in Production WebSocket Server (5K+ tokens)

## Bug Report
Our production WebSocket server is leaking memory at approximately 50MB per hour under moderate load (2000 concurrent connections). The server runs on Node.js 20.11.0 with Express + ws library. Memory starts at ~200MB and reaches the 2GB container limit in roughly 36 hours, at which point Kubernetes kills the pod.

## Server Architecture
The server handles real-time collaboration features for a document editing application. Each connected client subscribes to "rooms" (one per document), and the server broadcasts document changes to all clients in the same room.

## Source Code

### server.ts
```typescript
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { EventEmitter } from 'events';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

interface Client {
  ws: WebSocket;
  userId: string;
  rooms: Set<string>;
  lastPing: number;
  metadata: Record<string, unknown>;
}

interface Room {
  id: string;
  clients: Map<string, Client>;
  history: Array<{ userId: string; action: string; timestamp: number; payload: unknown }>;
  createdAt: number;
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
const eventBus = new EventEmitter();
eventBus.setMaxListeners(0); // Suppress warning

// Authentication middleware
function authenticateToken(token: string): { userId: string; name: string } | null {
  try {
    // JWT verification (simplified)
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return { userId: decoded.sub, name: decoded.name };
  } catch {
    return null;
  }
}

wss.on('connection', (ws: WebSocket, req) => {
  const token = new URL(req.url!, `http://${req.headers.host}`).searchParams.get('token');
  const user = token ? authenticateToken(token) : null;
  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const client: Client = {
    ws,
    userId: user.userId,
    rooms: new Set(),
    lastPing: Date.now(),
    metadata: { connectedAt: Date.now(), userAgent: req.headers['user-agent'] },
  };
  clients.set(user.userId, client);
  console.log(`Client connected: ${user.userId} (${clients.size} total)`);

  // Set up message handler
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      handleMessage(client, msg);
    } catch (err) {
      ws.send(JSON.stringify({ error: 'Invalid message format' }));
    }
  });

  ws.on('pong', () => {
    client.lastPing = Date.now();
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${user.userId}`);
    // Remove from rooms
    for (const roomId of client.rooms) {
      const room = rooms.get(roomId);
      if (room) {
        room.clients.delete(user.userId);
        broadcastToRoom(roomId, { type: 'user_left', userId: user.userId });
      }
    }
    clients.delete(user.userId);
  });

  // Set up per-client event listener for cross-tab sync
  const syncHandler = (event: { userId: string; action: string }) => {
    if (event.userId === user.userId) {
      ws.send(JSON.stringify({ type: 'sync', ...event }));
    }
  };
  eventBus.on('sync', syncHandler);

  // Heartbeat
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('close', () => {
    clearInterval(pingInterval);
    // BUG: syncHandler is never removed from eventBus
  });
});

function handleMessage(client: Client, msg: { type: string; roomId?: string; payload?: unknown }) {
  switch (msg.type) {
    case 'join_room':
      joinRoom(client, msg.roomId!);
      break;
    case 'leave_room':
      leaveRoom(client, msg.roomId!);
      break;
    case 'broadcast':
      if (msg.roomId && client.rooms.has(msg.roomId)) {
        const room = rooms.get(msg.roomId);
        if (room) {
          // Store in room history (never pruned!)
          room.history.push({
            userId: client.userId,
            action: 'broadcast',
            timestamp: Date.now(),
            payload: msg.payload,
          });
          broadcastToRoom(msg.roomId, {
            type: 'message',
            userId: client.userId,
            payload: msg.payload,
          }, client.userId);
        }
      }
      break;
    case 'cursor_move':
      // High-frequency event: cursor positions for collaborative editing
      if (msg.roomId && client.rooms.has(msg.roomId)) {
        const room = rooms.get(msg.roomId);
        if (room) {
          room.history.push({
            userId: client.userId,
            action: 'cursor_move',
            timestamp: Date.now(),
            payload: msg.payload,
          });
          broadcastToRoom(msg.roomId, {
            type: 'cursor',
            userId: client.userId,
            payload: msg.payload,
          }, client.userId);
        }
      }
      break;
  }
}

function joinRoom(client: Client, roomId: string) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { id: roomId, clients: new Map(), history: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }
  room.clients.set(client.userId, client);
  client.rooms.add(roomId);

  // Send room history to new joiner (can be massive for long-lived rooms)
  client.ws.send(JSON.stringify({ type: 'room_history', roomId, history: room.history }));

  broadcastToRoom(roomId, { type: 'user_joined', userId: client.userId }, client.userId);
}

function leaveRoom(client: Client, roomId: string) {
  const room = rooms.get(roomId);
  if (room) {
    room.clients.delete(client.userId);
    client.rooms.delete(roomId);
    broadcastToRoom(roomId, { type: 'user_left', userId: client.userId });
    // Room is never cleaned up even when empty
  }
}

function broadcastToRoom(roomId: string, message: unknown, excludeUserId?: string) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const [userId, client] of room.clients) {
    if (userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

// Cleanup stale connections
setInterval(() => {
  const now = Date.now();
  for (const [userId, client] of clients) {
    if (now - client.lastPing > 60000) {
      console.log(`Closing stale connection: ${userId}`);
      client.ws.terminate();
    }
  }
}, 30000);

server.listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
});
```

## Production Logs (last 4 hours, Kubernetes pod)
```
2024-03-15T10:00:01Z [info] Server running on port 3000
2024-03-15T10:00:05Z [info] Client connected: user-a1b2 (1 total)
2024-03-15T10:00:06Z [info] Client connected: user-c3d4 (2 total)
... (2000 connections established over 10 minutes)
2024-03-15T10:10:00Z [info] Client connected: user-z9y8 (2000 total)
2024-03-15T10:15:00Z [metrics] RSS: 245MB, heap_used: 198MB, external: 12MB, listeners(sync): 2000
2024-03-15T10:30:00Z [metrics] RSS: 312MB, heap_used: 267MB, external: 15MB, listeners(sync): 2847
2024-03-15T10:45:00Z [metrics] RSS: 389MB, heap_used: 341MB, external: 18MB, listeners(sync): 3692
2024-03-15T11:00:00Z [metrics] RSS: 478MB, heap_used: 422MB, external: 22MB, listeners(sync): 4538
2024-03-15T11:00:01Z [warn] EventEmitter listener count for 'sync' is 4538, expected ~2000
2024-03-15T11:15:00Z [metrics] RSS: 556MB, heap_used: 498MB, external: 25MB, listeners(sync): 5384
2024-03-15T11:30:00Z [metrics] RSS: 634MB, heap_used: 571MB, external: 28MB, listeners(sync): 6230
2024-03-15T12:00:00Z [metrics] RSS: 812MB, heap_used: 734MB, external: 34MB, listeners(sync): 7922
2024-03-15T12:00:01Z [warn] Room 'doc-abc123' history has 847,291 entries
2024-03-15T12:00:02Z [warn] Room 'doc-xyz789' history has 523,108 entries
2024-03-15T13:00:00Z [metrics] RSS: 1.2GB, heap_used: 1.08GB, external: 45MB, listeners(sync): 11306
2024-03-15T13:30:00Z [error] FATAL: OOMKilled - container exceeded 2GB memory limit
2024-03-15T13:30:01Z [kubernetes] Pod restarted (exit code 137)
```

## Heap Snapshot Analysis (taken at RSS=812MB)
```
Top retainers:
1. Room.history arrays: 423MB (52% of heap)
   - doc-abc123: 187MB (847,291 entries, avg 220 bytes each)
   - doc-xyz789: 116MB (523,108 entries, avg 222 bytes each)
   - 47 other rooms: 120MB combined
2. EventEmitter listeners: 156MB (19% of heap)
   - 'sync' event: 7,922 listeners (expected ~2,000)
   - Each listener closure retains reference to Client + WebSocket objects
   - Disconnected clients' closures are never removed
3. Client.metadata objects: 34MB (4% of heap)
   - userAgent strings averaged 312 bytes each
4. Serialized message buffers in ws send queue: 67MB (8% of heap)

## Error trace from node --inspect heap analysis:
  at syncHandler (server.ts:89:5)
  at EventEmitter.emit (events:394:28)
  retained by: eventBus._events.sync[3847]
  -> closure scope: { user: { userId: 'user-disconnected-4821', ... }, ws: [CLOSED WebSocket] }
```

## What we've tried
1. Increased container memory to 2GB (was 1GB) -- just delays the crash
2. Added `ws.ping()` heartbeat -- helps detect dead connections but doesn't fix the leak
3. Set `eventBus.setMaxListeners(0)` -- just suppresses the warning, doesn't fix anything
4. Restarting pods every 12 hours via CronJob -- band-aid, causes brief service disruption

## Deployment Configuration

### package.json
```json
{
  "name": "collab-ws-server",
  "version": "2.4.1",
  "main": "dist/server.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "loadtest": "artillery run loadtest.yml"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "jsonwebtoken": "^9.0.2",
    "pino": "^8.19.0",
    "prom-client": "^15.1.0"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "tsx": "^4.7.0",
    "vitest": "^1.2.0",
    "artillery": "^2.0.6",
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.11.0"
  }
}
```

### Dockerfile
```dockerfile
FROM node:20.11-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM node:20.11-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "--max-old-space-size=1536", "dist/server.js"]
```

### kubernetes/deployment.yaml
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: collab-ws-server
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: collab-ws-server
  template:
    metadata:
      labels:
        app: collab-ws-server
    spec:
      containers:
      - name: collab-ws-server
        image: registry.internal/collab-ws-server:2.4.1
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        env:
        - name: PORT
          value: "3000"
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: collab-secrets
              key: jwt-secret
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: collab-secrets
              key: redis-url
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
```

## Load Test Results (artillery)
```
Summary report @ 14:30:00(+0000)
  Scenarios launched:  10000
  Scenarios completed: 9847
  Requests completed:  98470
  Mean response/sec:   164.12
  Response time (msec):
    min: 2
    max: 12847
    median: 45
    p95: 890
    p99: 4521
  Codes:
    101: 9847   (WebSocket upgrade)
    502: 153    (Bad Gateway - pod restart during test)

WebSocket metrics:
  Messages sent:    2,847,291
  Messages received: 2,734,108
  Connection errors: 153
  Disconnects:      847 (timeout)
  Mean msg latency:  23ms
  p99 msg latency:   1,247ms
```

## Grafana Dashboard Metrics (last 24 hours)
```
pod/collab-ws-server-7d8f9c-abc:
  container_memory_rss:
    10:00 -> 245MB
    12:00 -> 812MB
    14:00 -> 1.4GB
    16:00 -> OOMKilled (2GB limit)
    16:01 -> 198MB (restart)
    18:00 -> 534MB
    20:00 -> 987MB
    22:00 -> 1.6GB
    00:00 -> OOMKilled (2GB limit)
    00:01 -> 195MB (restart)

  go_goroutines (envoy sidecar): stable at 47
  process_open_fds: 2000 -> 2847 -> 4538 (growing with listener leak)

pod/collab-ws-server-7d8f9c-def:
  Similar pattern, OOMKilled every ~16 hours
  
pod/collab-ws-server-7d8f9c-ghi:
  Similar pattern, OOMKilled every ~18 hours
```

## Previous Incident Postmortem (2 weeks ago)
During peak hours (Monday 9am EST), all 3 pods were OOMKilled within a 2-hour window due to a surge in cursor_move events from 500 simultaneous document editors. The room history for the most active document grew to 2.3 million entries in 4 hours. Service was completely down for 8 minutes until pods restarted and clients reconnected.

Temporary mitigation was to increase pods from 2 to 3 and add a CronJob to restart pods every 12 hours. This reduces the blast radius but doesn't fix the underlying issue.

## Team Notes
- @sarah: "I think the EventEmitter listener leak is the main issue. Each reconnecting user adds a new listener without removing the old one."
- @mike: "The room.history is the bigger problem. cursor_move events are ~60/second per user. With 50 users in a room, that's 3000 entries/second."
- @priya: "We should also look at why rooms are never cleaned up even when they're empty. I count 847 empty rooms in the current state."
- @alex: "The Client.metadata storing full userAgent strings for 2000+ connections seems wasteful too. But that's only 34MB, small compared to the other leaks."

## Question
Please identify ALL memory leak sources in this code and provide specific fixes. We need:
1. Root cause analysis for each leak with memory impact estimates
2. Code fixes with minimal changes to the existing architecture
3. Priority ordering (which fix gives the most memory savings)
4. Any additional monitoring we should add
5. A recommendation for whether we need architectural changes (e.g., Redis pub/sub instead of in-process EventEmitter)
