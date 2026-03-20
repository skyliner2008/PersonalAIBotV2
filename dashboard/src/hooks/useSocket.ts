import { useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

function resolveSocketUrl(): string {
  const explicit = String((import.meta as any).env?.VITE_SOCKET_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');

  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    if (port === '5173' || port === '5174' || port === '4173') {
      return `${protocol}//${hostname}:3000`;
    }
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  }

  return 'http://localhost:3000';
}

const SOCKET_URL = resolveSocketUrl();
const SOCKET_TOKEN_PARAM_KEYS = ['socket_token', 'st'];
const JWT_TOKEN_KEY = 'auth_jwt_token';

let sharedSocket: Socket | null = null;
let sharedSocketPromise: Promise<Socket> | null = null;
let remoteBootstrapAttempted = false;

function getStoredSocketToken(): string | undefined {
  try {
    const token = localStorage.getItem('socket_auth_token');
    return token || undefined;
  } catch {
    return undefined;
  }
}

function isLocalDashboardHost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function pullSocketTokenFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const url = new URL(window.location.href);
    let token: string | null = null;

    for (const key of SOCKET_TOKEN_PARAM_KEYS) {
      const value = String(url.searchParams.get(key) || '').trim();
      if (value) {
        token = value;
      }
      url.searchParams.delete(key);
    }

    if (!token) return undefined;

    try {
      localStorage.setItem('socket_auth_token', token);
    } catch {
      // ignore storage errors
    }

    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return token;
  } catch {
    return undefined;
  }
}

async function resolveSocketToken(): Promise<string | undefined> {
  const stored = getStoredSocketToken();
  if (stored) return stored;

  const urlToken = pullSocketTokenFromUrl();
  if (urlToken) return urlToken;

  const envToken = (import.meta as any).env?.VITE_SOCKET_AUTH_TOKEN;
  if (envToken) return envToken;

  let jwtToken: string | null = null;
  try {
    jwtToken = localStorage.getItem(JWT_TOKEN_KEY);
  } catch {
    jwtToken = null;
  }

  // Remote dashboard may still bootstrap a token once (if server allows it).
  // Prevent repeated remote token hammering when not allowed.
  if (!isLocalDashboardHost() && !jwtToken) {
    if (remoteBootstrapAttempted) {
      return undefined;
    }
    remoteBootstrapAttempted = true;
  }

  try {
    const headers: Record<string, string> = {};
    if (jwtToken) {
      headers.Authorization = `Bearer ${jwtToken}`;
    }

    const resp = await fetch(`${SOCKET_URL}/api/auth/socket-token`, {
      headers: Object.keys(headers).length ? headers : undefined,
    });
    if (!resp.ok) return undefined;
    const data = await resp.json();
    if (data?.token) {
      try { localStorage.setItem('socket_auth_token', data.token); } catch { /* ignore */ }
      return data.token;
    }
  } catch {
    // Server may not be ready yet.
  }

  return undefined;
}

async function getOrCreateSharedSocket(): Promise<Socket> {
  if (sharedSocket) return sharedSocket;
  if (sharedSocketPromise) return sharedSocketPromise;

  sharedSocketPromise = (async () => {
    const token = await resolveSocketToken();
    let authRefreshInFlight = false;
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      auth: token ? { token } : undefined,
    });

    socket.on('connect_error', async (err) => {
      if (err.message !== 'Authentication required') return;
      if (authRefreshInFlight) return;
      authRefreshInFlight = true;

      try {
        try { localStorage.removeItem('socket_auth_token'); } catch { /* ignore */ }
        const refreshedToken = await resolveSocketToken();
        if (!refreshedToken) {
          // Stop aggressive reconnect loop when remote dashboard has no token source.
          console.warn('[Socket] Authentication required but no socket token is available.');
          socket.io.opts.reconnection = false;
          socket.disconnect();
          return;
        }

        const currentToken = String((socket.auth as any)?.token || '').trim();
        if (currentToken === refreshedToken.trim()) {
          console.warn('[Socket] Authentication failed with current token; waiting for a new token.');
          socket.io.opts.reconnection = false;
          socket.disconnect();
          return;
        }

        socket.auth = { token: refreshedToken };
        socket.connect();
      } finally {
        authRefreshInFlight = false;
      }
    });

    sharedSocket = socket;
    return socket;
  })();

  try {
    return await sharedSocketPromise;
  } finally {
    sharedSocketPromise = null;
  }
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(sharedSocket);
  const [connected, setConnected] = useState<boolean>(sharedSocket?.connected ?? false);

  useEffect(() => {
    let mounted = true;
    let socket: Socket | null = null;

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    getOrCreateSharedSocket().then((s) => {
      if (!mounted) return;
      socket = s;
      socketRef.current = s;
      setConnected(s.connected);
      s.on('connect', onConnect);
      s.on('disconnect', onDisconnect);
    });

    return () => {
      mounted = false;
      if (socket) {
        socket.off('connect', onConnect);
        socket.off('disconnect', onDisconnect);
      }
    };
  }, []);

  const emit = useCallback((event: string, ...args: any[]) => {
    socketRef.current?.emit(event, ...args);
  }, []);

  const on = useCallback((event: string, handler: (...args: any[]) => void) => {
    socketRef.current?.on(event, handler);
    return () => {
      socketRef.current?.off(event, handler);
    };
  }, []);

  return { socket: socketRef.current, connected, emit, on };
}
