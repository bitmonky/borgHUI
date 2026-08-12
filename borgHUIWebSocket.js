// borgHUIWebSocket.js - WebSocket integration for peerTree

const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');

class BorgHUIWebSocket extends EventEmitter {
  constructor(net, config = {}) {
    super();
    
    this.wallet = net.wallet;
    this.net = net;
    this.portals = net.portal.getPortalsAll('chatOrganismCell');
    this.nodeId = config.nodeId || crypto.randomUUID();
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.maxReconnectAttempts || 10;
    this.reconnectDelay = config.reconnectDelay || 5000;
    
    // WebSocket connection
    this.ws = null;

    const randomIndex = Math.floor(Math.random() * this.portals.nodes.length);
    const portal = this.portals.nodes[randomIndex];

    this.wsUrl = `wss://${portal.ip}:${this.portals.wsSoc}`;
    console.log(`BorgHUIWebSocket():: using `,this.wsUrl);
    
    // Message handling
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    this.requestTimeout = config.requestTimeout || 30000;
    
    // Room subscriptions
    this.rooms = new Map(); // roomId -> Set(address)
    this.roomHistory = new Map(); // roomId -> [messages]
    
    // Callbacks
    this.eventListeners = new Map();
    
    // Heartbeat
    this.heartbeatInterval = null;
    this.heartbeatTimeout = config.heartbeatTimeout || 30000;
    
    // Initialize
    this._setupDefaultHandlers();
    
    // Auto-connect if configured
    if (config.autoConnect !== false) {
      this.connect();
    }
  }
  // ============ BorgChat API =====================
  async doCreateChannel(j){
    const borgToken = this.net.wallet.getBorgToken();

    this.send({
      type     : 'req',
      req      : 'createBorgChannel',
      data     : j.data,
      borgToken:  borgToken
    });
    return false;
  }
  // ============ CONNECTION MANAGEMENT ============

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('WebSocket already connected');
      return;
    }

    console.log(`🔌 Connecting to ${this.wsUrl}`);
    
    try {
      this.ws = new WebSocket(this.wsUrl, {
        rejectUnauthorized: false, // For self-signed certs
      });

      this.ws.on('open', () => {
        this._handleOpen();
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        this._handleClose(code, reason);
      });

      this.ws.on('error', (error) => {
        this._handleError(error);
      });

      this.ws.on('pong', () => {
        this._handlePong();
      });

    } catch (error) {
      console.error('WebSocket connection error:', error);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
    }
    this.connected = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }

  _handleOpen() {
    console.log('✅ WebSocket connected');
    this.connected = true;
    this.reconnectAttempts = 0;
    
    // Start heartbeat
    this._startHeartbeat();
    
    // Authenticate with BorgToken
    this._authenticate();
    
    this.emit('connected');
  }

  _handleClose(code, reason) {
    console.log(`❌ WebSocket closed: ${code} - ${reason}`);
    this.connected = false;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.emit('disconnected', { code, reason });
    
    // Reconnect if not intentional
    if (code !== 1000) {
      this._scheduleReconnect();
    }
  }

  _handleError(error) {
    console.error('WebSocket error:', error);
    this.emit('error', error);
  }

  _handlePong() {
    // Heartbeat received
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      this.emit('reconnect_failed');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 30000);
    
    console.log(`🔄 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  _startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.heartbeatTimeout);
  }

  // ============ AUTHENTICATION ============

  _authenticate() {
    const borgToken = this.net.wallet.getBorgToken();
    
    this.send({
      type: 'auth',
      borgToken:  borgToken
    });
  }

  // ============ MESSAGE HANDLING ============

  _handleMessage(data) {
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
      
      console.log('📨 Received:', message.type || 'unknown');
      
      // Handle response to pending request
      if (message.requestId && this.pendingRequests.has(message.requestId)) {
        const { resolve, reject, timeout } = this.pendingRequests.get(message.requestId);
        clearTimeout(timeout);
        this.pendingRequests.delete(message.requestId);
        
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message);
        }
        return;
      }
      
      // Route message to handlers
      this._routeMessage(message);
      
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  }

  _routeMessage(message) {
    let type = message.type || 'default';
    console.log(`_routeMessage():: `,message);
    if (type === 'response'){
      type = message.original.req || message.original.type;
      console.log(`_routeMessage():: type `,type);
    }
 
    // Check for registered handlers
    if (this.messageHandlers.has(type)) {
      this.messageHandlers.get(type)(message);
      return;
    }
    
    // Handle specific message types
    switch(type) {
      case 'welcome':
        this._handleWelcome(message);
        break;
      case 'auth_success':
        this._handleAuthSuccess(message);
        break;
      case 'auth_failed':
        this._handleAuthFailed(message);
        break;
      case 'pushBorgChat':
        this._handleChatMessage(message);
        break;
      case 'direct_message':
        this._handleDirectMessage(message);
        break;
      case 'openBorgChannel':
        this._handleOpenBorgChannel(message);
        break;
      case 'createBorgChannel':
        this._handleRoomCreated(message);
        break;
      case 'participant_joined':
        this._handleParticipantJoined(message);
        break;
      case 'participant_left':
        this._handleParticipantLeft(message);
        break;
      case 'room_history':
        this._handleRoomHistory(message);
        break;
      case 'client_connected':
        this._handleClientConnected(message);
        break;
      case 'client_disconnected':
        this._handleClientDisconnected(message);
        break;
      case 'error':
        this._handleError(message);
        break;
      default:
        console.log('Unhandled message type:', type);
        this.emit('message', message);
    }
  }

  _setupDefaultHandlers() {
    // Default message handler
    this.messageHandlers.set('default', (message) => {
      this.emit('message', message);
    });
  }

  // ============ MESSAGE HANDLERS ============

  _handleWelcome(message) {
    console.log('👋 Welcome to BorgIOS Chat Services network');
    console.log(`Node ID: ${message.nodeId}`);
    console.log(`Client ID: ${message.clientId}`);
    
    this.clientId = message.clientId;
    this.nodeId = message.nodeId;
    this.nodeLoad = message.nodeLoad;
    
    this.emit('welcome', message);
  }

  _handleAuthSuccess(message) {
    console.log('🔐 Authentication successful');
    console.log(`Address: ${message.address}`);
    this.authenticated = true;
    this.address = message.address;
    
    this.emit('authenticated', message);
  }

  _handleAuthFailed(message) {
    console.error('❌ Authentication failed:', message.error);
    this.authenticated = false;
    this.emit('auth_failed', message);
  }

  _handleChatMessage(message) {
    const { chanId, chatMessage } = message;
    
    console.log(`💬 Chat message in ${chanId} from ${chatMessage.from}`);
    
    // Store in local history
    if (!this.roomHistory.has(chanId)) {
      this.roomHistory.set(chanId, []);
    }
    this.roomHistory.get(chanId).push(chatMessage);
    this.net.pushEvent('borg-event',{req:"postNewBorgChat",chanId:chanId,chat:chatMessage});
     
    this.emit('chat_message', message);
  }

  _handleDirectMessage(message) {
    console.log(`📨 Direct message from ${message.from}`);
    this.emit('direct_message', message);
  }
  _handleOpenBorgChannel(msg){
    console.log(`_handleOpenBorgChannel(msg):: `,msg);
    const users = msg.chan.chanState.users;
    const userInfo = [];
    users.forEach( (user) =>{
      const u = {muid: user.msubMUID,nic: user.msubBorgNic, icon:  this._buildIcon(user)};
      userInfo.push(u);
    });
    msg.chan.chanState.users = userInfo;
    console.log(`_handleOpenBorgChannel(msg):: is now ==> `,msg); 
    this.net.pushEvent('borg-event',{req:"openBorgChannel",msg:msg});
   }
   _buildIcon(u){
      let url = 'http:/localhost/'
      if (u.msubIconFUID) {
        return `${url}file=${u.msubIconFUID}`;
      }
      return `${url}netREQ/msg=%7B"req":"getFileFromRepo","url":"/whzon/bitMiner/getFileFromRepo.php?wzID=DESKTOP&fname=${u.msubIconFName}` +
             `&rname=${u.msubIconRName}&path=${u.msubIconPath}&ownerMUID=${u.msubMUID}&folderID=${u.msubIconFolder}&encrypt=0","checkSum":"${u.msubIconFCSum}` +
             `","ftype":"${u.msubIconFType}`;

   }
  _handleRoomCreated(message) {
    if (message.original.json.error === 'false'){
      console.log(`🏠 Room created: ${message.roomId} by ${message.creator}`);
      this.emit('room_created', message);
    }
    else { 
     console.log( `🏠 Room create Failed:`,message);
     return;
    }
    console.log(`_handleRoomCreated(message):: `,message);
    const state = message.original.json.msg;
    
    this.net.pushEvent('borg-event',{req:"createBorgChannel",state: state});
     
  }

  _handleParticipantJoined(message) {
    console.log(`👤 ${message.participant} joined ${message.roomId}`);
    this.emit('participant_joined', message);
  }

  _handleParticipantLeft(message) {
    console.log(`👋 ${message.participant} left ${message.roomId}`);
    this.emit('participant_left', message);
  }

  _handleRoomHistory(message) {
    console.log(`📜 Room history loaded for ${message.roomId}: ${message.history.length} messages`);
    
    // Store history locally
    if (message.history && message.history.length > 0) {
      if (!this.roomHistory.has(message.roomId)) {
        this.roomHistory.set(message.roomId, []);
      }
      this.roomHistory.get(message.roomId).push(...message.history);
    }
    
    this.emit('room_history', message);
  }

  _handleClientConnected(message) {
    console.log(`🟢 ${message.address} connected to node ${message.nodeId}`);
    this.emit('client_connected', message);
  }

  _handleClientDisconnected(message) {
    console.log(`🔴 ${message.address} disconnected`);
    this.emit('client_disconnected', message);
  }

  // ============ SEND METHODS ============

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return false;
    }
    
    try {
      this.ws.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error('Send error:', error);
      return false;
    }
  }

  sendWithResponse(data, timeout = null) {
    return new Promise((resolve, reject) => {
      const requestId = data.requestId || crypto.randomUUID();
      data.requestId = requestId;
      
      const timeoutMs = timeout || this.requestTimeout;
      
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.log(`sendWithResponse():: Request timeout`,this.pendingRequests);
      }, timeoutMs);
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle
      });
      
      if (!this.send(data)) {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(new Error('Failed to send message'));
      }
    });
  }

  // ============ ROOM OPERATIONS ============

  createRoom(name, metadata = {}) {
    return this.sendWithResponse({
      type: 'room',
      action: 'create',
      data: {
        name: name,
        metadata: metadata
      }
    });
  }

  joinRoom(roomId) {
    if (this.rooms.has(roomId)) {
      console.log(`Already in room ${roomId}`);
      return Promise.resolve();
    }
    
    return this.sendWithResponse({
      type: 'room',
      action: 'join',
      roomId: roomId
    }).then(() => {
      if (!this.rooms.has(roomId)) {
        this.rooms.set(roomId, new Set());
      }
      this.emit('room_joined', { roomId });
    });
  }

  leaveRoom(roomId) {
    this.rooms.delete(roomId);
    
    return this.sendWithResponse({
      type: 'room',
      action: 'leave',
      roomId: roomId
    });
  }

  listRooms() {
    return this.sendWithResponse({
      type: 'room',
      action: 'list'
    });
  }

  sendChatMessage(roomId, content) {
    if (!this.rooms.has(roomId)) {
      console.log(`Not in this room`);
    }
    
    return this.sendWithResponse({
      type: 'chat',
      roomId: roomId,
      content: content
    });
  }

  // ============ DIRECT MESSAGES ============

  sendDirectMessage(to, content) {
    return this.sendWithResponse({
      type: 'direct',
      to: to,
      content: content
    });
  }

  // ============ HISTORY ============

  getRoomHistory(roomId, limit = 50) {
    return this.sendWithResponse({
      type: 'history',
      roomId: roomId,
      limit: limit
    });
  }

  getLocalHistory(roomId, limit = 50) {
    const history = this.roomHistory.get(roomId) || [];
    return history.slice(-limit);
  }

  // ============ EVENT SYSTEM ============

  on(event, listener) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(listener);
  }

  emit(event, data) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data);
        } catch (error) {
          console.error(`Event listener error for ${event}:`, error);
        }
      }
    }
  }

  // ============ UTILITY METHODS ============

  isConnected() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  isAuthenticated() {
    return this.authenticated && this.isConnected();
  }

  getStatus() {
    return {
      connected: this.isConnected(),
      authenticated: this.isAuthenticated(),
      nodeId: this.nodeId,
      clientId: this.clientId,
      address: this.address,
      rooms: Array.from(this.rooms.keys()),
      roomCount: this.rooms.size,
      pendingRequests: this.pendingRequests.size
    };
  }

  // ============ SHUTDOWN ============

  shutdown() {
    console.log('Shutting down WebSocket client...');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Clear pending requests
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error('Client shutting down'));
    }
    this.pendingRequests.clear();
    
    if (this.ws) {
      this.ws.close(1000, 'Client shutting down');
    }
    
    this.connected = false;
    this.authenticated = false;
    
    console.log('WebSocket client shutdown complete');
  }
}

module.exports.BorgHUIWebSocket = BorgHUIWebSocket;
