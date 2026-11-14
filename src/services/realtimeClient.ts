export type RealtimeEventType =
  | 'presence:snapshot'
  | 'presence:update'
  | 'typing:update'
  | 'chat:message'
  | 'chat:deleted'
  | 'chat:pinned'
  | 'channel:post'
  | 'deal:updated'
  | 'wallet:updated'
  | 'ticket:updated'
  | 'dispute:updated'
  | 'notification:new';

type Listener = (payload: any) => void;

class RealtimeClient {
  private ws: WebSocket | null = null;
  private userId: string | null = null;
  private sessionToken: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private manualClose = false;
  private joinedRooms = new Set<string>();
  private onlineIds = new Set<string>();
  private listeners = new Map<string, Set<Listener>>();

  connect(userId: string | number, sessionToken?: string | null) {
    const uid = String(userId || '').trim();
    if (!uid) return;

    const token = sessionToken ?? (typeof window !== 'undefined' ? localStorage.getItem('mianji_session_token') : null);
    if (this.ws && this.userId === uid && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.userId = uid;
    this.sessionToken = token;
    this.manualClose = false;
    this.openSocket();
  }

  disconnect() {
    this.manualClose = true;
    this.userId = null;
    this.sessionToken = null;
    this.joinedRooms.clear();
    this.onlineIds.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private openSocket() {
    if (typeof window === 'undefined' || !this.userId) return;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    params.set('uid', this.userId);
    if (this.sessionToken) params.set('token', this.sessionToken);

    const url = `${proto}//${window.location.host}/ws?${params.toString()}`;
    try {
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.onopen = () => {
        this.reconnectAttempts = 0;
        for (const room of this.joinedRooms) {
          this.sendRaw({ type: 'room:join', room });
        }
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          this.sendRaw({ type: 'ping' });
        }, 25000);
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (!msg?.type) return;

          if (msg.type === 'presence:snapshot' && Array.isArray(msg.payload?.onlineIds)) {
            this.onlineIds = new Set(msg.payload.onlineIds.map(String));
          } else if (msg.type === 'presence:update' && msg.payload?.userId) {
            const targetId = String(msg.payload.userId);
            if (msg.payload.online) this.onlineIds.add(targetId);
            else this.onlineIds.delete(targetId);
          }

          const handlers = this.listeners.get(msg.type);
          if (handlers) {
            handlers.forEach((fn) => {
              try {
                fn(msg.payload);
              } catch {}
            });
          }
        } catch {}
      };

      socket.onclose = () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.ws = null;
        if (!this.manualClose && this.userId) {
          const delay = Math.min(10000, 800 * Math.pow(1.6, this.reconnectAttempts));
          this.reconnectAttempts += 1;
          this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
        }
      };

      socket.onerror = () => {
        // Error handler prevents unhandled console noise; onclose handles reconnect
      };
    } catch {}
  }

  private sendRaw(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch {}
    }
  }

  subscribeRoom(room: string) {
    if (!room) return;
    this.joinedRooms.add(room);
    this.sendRaw({ type: 'room:join', room });
  }

  unsubscribeRoom(room: string) {
    if (!room) return;
    this.joinedRooms.delete(room);
    this.sendRaw({ type: 'room:leave', room });
  }

  sendTyping(room: string, isTyping: boolean, fullName?: string) {
    if (!room) return;
    this.sendRaw({ type: 'typing', room, isTyping, fullName: fullName || '' });
  }

  isUserOnline(userId?: string | number | null): boolean {
    if (!userId) return false;
    return this.onlineIds.has(String(userId));
  }

  on(eventType: RealtimeEventType, listener: Listener): () => void {
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }
}

export const realtimeClient = new RealtimeClient();
