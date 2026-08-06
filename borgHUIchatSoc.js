// Client-side secure WebSocket connection
class SecureBORGWebSocket {
  constructor(options) {
    this.ws = null;
    this.token = options.token;
    this.userId = options.userId;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.messageQueue = [];
    this.connected = false;
    this.heartbeatInterval = null;
    
    this.connect();
  }
  
  connect() {
    try {
      // Use wss:// for secure connection
      const wsUrl = `wss://${this.getEndpoint()}?token=${this.token}&userId=${this.userId}`;
      
      // Create WebSocket with SSL
      this.ws = new WebSocket(wsUrl, {
        // Security options
        rejectUnauthorized: true, // Verify SSL certificate
        perMessageDeflate: true,
        // Optional: Add custom headers
        headers: {
          'X-BORG-Version': '1.0',
          'User-Agent': 'BORG-Client/1.0'
        }
      });
      
      this.ws.onopen = () => {
        console.log('✅ Secure WebSocket connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        this.flushQueue();
        this.startHeartbeat();
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
      
      this.ws.onclose = (event) => {
        console.log(`🔒 WebSocket closed: ${event.code} - ${event.reason}`);
        this.connected = false;
        this.stopHeartbeat();
        this.handleDisconnect();
      };
      
      this.ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
      };
      
    } catch (error) {
      console.error('❌ Failed to connect:', error);
      this.handleDisconnect();
    }
  }
  
  startHeartbeat() {
    // Send periodic ping to keep connection alive
    this.heartbeatInterval = setInterval(() => {
      if (this.connected && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now()
        }));
      }
    }, 30000); // Every 30 seconds
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  
  sendSecure(data) {
    // Encrypt sensitive data before sending
    const encrypted = this.encryptData(data);
    this.ws.send(JSON.stringify({
      type: 'secure',
      data: encrypted,
      timestamp: Date.now(),
      signature: this.signData(data)
    }));
  }
  
  encryptData(data) {
    // Use client-side encryption
    const key = this.deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex')
    };
  }
  
  deriveKey() {
    // Derive key from user's private key
    return crypto.createHash('sha256')
      .update(this.privateKey)
      .digest();
  }
  
  signData(data) {
    // Sign data with private key
    const signature = crypto.createSign('sha256');
    signature.update(JSON.stringify(data));
    return signature.sign(this.privateKey, 'hex');
  }
}

// Borg Chat Client with Dynamic Endpoint Selection + Failover
class BorgChatClient {
  constructor(options = {}) {
    this.userId = options.userId;
    this.token = options.token;
    this.portal = new ServiceDiscovery();
    this.currentEndpoint = null;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.messageQueue = [];
    this.connected = false;
    this.rooms = ['general'];
    this.listeners = [];
  }
  
  async connect() {
    try {
      // 1. Discover endpoints
      const endpoints = await this.getEndpoints();
      
      // 2. Try each endpoint until one works
      for (const endpoint of endpoints) {
        try {
          const connected = await this.tryConnect(endpoint);
          if (connected) {
            this.currentEndpoint = endpoint;
            console.log(`✅ Connected to ${endpoint.url}`);
            return true;
          }
        } catch (err) {
          console.log(`❌ Failed to connect to ${endpoint.url}:`, err.message);
          // Mark endpoint as failed
          this.markEndpointFailed(endpoint);
          continue;
        }
      }
      
      // 3. All endpoints failed
      console.error('❌ All endpoints failed');
      return false;
      
    } catch (err) {
      console.error('Connection error:', err);
      return false;
    }
  }
  
  async getEndpoints() {
    // Get endpoints from portal
    const endpoints = await this.portal.getWebSocketEndpoints();
    
    // Filter out recently failed endpoints
    const healthy = endpoints.filter(e => !this.isFailed(e));
    
    // Sort by lastSeen (newer first) and load (lighter first)
    healthy.sort((a, b) => {
      if (a.load !== b.load) return a.load - b.load;
      return new Date(b.lastSeen) - new Date(a.lastSeen);
    });
    
    // Randomize first 3 for load balancing
    const top = healthy.slice(0, 3);
    const rest = healthy.slice(3);
    
    // Shuffle top 3
    for (let i = top.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [top[i], top[j]] = [top[j], top[i]];
    }
    
    return [...top, ...rest];
  }
  
  tryConnect(endpoint) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(endpoint.url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, 10000);
      
      ws.onopen = () => {
        clearTimeout(timeout);
        this.ws = ws;
        this.connected = true;
        this.reconnectAttempts = 0;
        this.setupHandlers();
        resolve(true);
      };
      
      ws.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
      
      ws.onclose = () => {
        clearTimeout(timeout);
        // Don't reject if close is intentional
        if (!this.connected) {
          reject(new Error('Connection closed'));
        }
      };
    });
  }
  
  setupHandlers() {
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.handleMessage(message);
    };
    
    this.ws.onclose = () => {
      this.connected = false;
      this.handleDisconnect();
    };
    
    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }
  
  handleDisconnect() {
    // Attempt to reconnect
    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error('❌ Max reconnect attempts reached');
      this.emit('disconnected', 'Max reconnect attempts');
      return;
    }
    
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    console.log(`🔄 Reconnecting in ${delay}ms... (attempt ${this.reconnectAttempts})`);
    
    setTimeout(async () => {
      const connected = await this.connect();
      if (connected) {
        // Resubscribe to rooms
        for (const room of this.rooms) {
          this.joinRoom(room);
        }
        
        // Resend queued messages
        this.flushQueue();
      }
    }, delay);
  }
  
  async failover() {
    console.log('🔄 Initiating failover...');
    
    // Close current connection
    if (this.ws) {
      this.ws.close();
    }
    
    // Mark current endpoint as failed
    if (this.currentEndpoint) {
      this.markEndpointFailed(this.currentEndpoint);
    }
    
    // Try to connect to new endpoint
    const connected = await this.connect();
    if (connected) {
      // Resubscribe to rooms
      for (const room of this.rooms) {
        this.joinRoom(room);
      }
      
      // Resend queued messages
      this.flushQueue();
      
      this.emit('failover', this.currentEndpoint);
      console.log(`✅ Failover complete, new endpoint: ${this.currentEndpoint.url}`);
    } else {
      console.error('❌ Failover failed');
      this.emit('failover_failed');
    }
  }
  
  sendMessage(text) {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const message = {
        type: 'message',
        room: this.currentRoom || 'general',
        text: text,
        userId: this.userId,
        timestamp: Date.now()
      };
      
      this.ws.send(JSON.stringify(message));
      this.emit('message_sent', message);
    } else {
      // Queue message for later
      this.messageQueue.push({ text, room: this.currentRoom });
      console.log('📦 Message queued (offline)');
    }
  }
  
  flushQueue() {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      this.sendMessage(msg.text);
    }
  }
  
  joinRoom(room) {
    if (!this.rooms.includes(room)) {
      this.rooms.push(room);
    }
    
    if (this.connected) {
      this.ws.send(JSON.stringify({
        type: 'join',
        room: room
      }));
    }
    
    this.currentRoom = room;
  }
  
  markEndpointFailed(endpoint) {
    // Store in local storage
    const failures = JSON.parse(localStorage.getItem('failedEndpoints') || '{}');
    failures[endpoint.url] = {
      failedAt: Date.now(),
      cooldown: 60000 // 1 minute cooldown
    };
    localStorage.setItem('failedEndpoints', JSON.stringify(failures));
  }
  
  isFailed(endpoint) {
    const failures = JSON.parse(localStorage.getItem('failedEndpoints') || '{}');
    const failure = failures[endpoint.url];
    if (!failure) return false;
    
    // Check if cooldown expired
    if (Date.now() - failure.failedAt > failure.cooldown) {
      delete failures[endpoint.url];
      localStorage.setItem('failedEndpoints', JSON.stringify(failures));
      return false;
    }
    
    return true;
  }
}

// Periodic health checks for endpoints
class EndpointHealthMonitor {
  constructor(client) {
    this.client = client;
    this.healthCheckInterval = 30000; // 30 seconds
    this.startMonitoring();
  }
  
  startMonitoring() {
    setInterval(async () => {
      await this.checkCurrentEndpoint();
    }, this.healthCheckInterval);
  }
  
  async checkCurrentEndpoint() {
    if (!this.client.currentEndpoint) return;
    
    try {
      // Send ping
      const response = await fetch(
        `https://${this.client.currentEndpoint.ip}:${this.client.currentEndpoint.port}/health`
      );
      
      const health = await response.json();
      
      if (health.status !== 'healthy') {
        console.warn('⚠️ Endpoint unhealthy, initiating failover');
        await this.client.failover();
      }
      
      if (health.load > 0.8) {
        console.warn('⚠️ Endpoint overloaded, considering failover');
        // Maybe failover if load is too high
      }
      
    } catch (err) {
      console.warn('⚠️ Health check failed:', err.message);
      await this.client.failover();
    }
  }
}

// Portal file includes WebSocket endpoints
const portalRegistry = {
  netName: 'borgChatCell',
  recpPort: 1396,           // HTTP API port
  wsPort: 1397,             // WebSocket port
  activeNodes: [
    { 
      ip: '192.168.1.100', 
      wsPort: 1397,
      lastSeen: '2024-01-15T12:00:00Z',
      load: 0.3,
      status: 'healthy'
    },
    { 
      ip: '192.168.1.101', 
      wsPort: 1397,
      lastSeen: '2024-01-15T12:00:00Z',
      load: 0.2,
      status: 'healthy'
    },
    { 
      ip: '192.168.1.102', 
      wsPort: 1397,
      lastSeen: '2024-01-15T11:58:00Z',
      load: 0.1,
      status: 'healthy'
    }
  ]
};

// Client asks for WebSocket endpoints
class WebSocketDiscovery {
  async getWebSocketEndpoints() {
    // 1. Load portal file
    const portals = this.loadPortals();
    const chatService = portals.find(p => p.netName === 'borgChatCell');
    
    // 2. Get all active nodes
    const nodes = chatService.activeNodes
      .filter(n => n.status === 'healthy')
      .map(n => ({
        url: `wss://${n.ip}:${n.wsPort || chatService.wsPort}/chat`,
        ip: n.ip,
        port: n.wsPort || chatService.wsPort,
        load: n.load || 0,
        lastSeen: n.lastSeen
      }));
    
    // 3. Sort by load (lightest first)
    nodes.sort((a, b) => a.load - b.load);
    
    return nodes;
  }
  
  async getRandomEndpoint() {
    const endpoints = await this.getWebSocketEndpoints();
    
    // If only one, return it
    if (endpoints.length === 1) return endpoints[0];
    
    // Random selection (load balancing)
    const index = Math.floor(Math.random() * endpoints.length);
    return endpoints[index];
  }
}
