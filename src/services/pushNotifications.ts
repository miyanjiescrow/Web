import { getApps } from 'firebase/app';
import { getMessaging, getToken, isSupported as isFcmSupported, onMessage } from 'firebase/messaging';
import { apiFetch } from '../lib/apiClient';
import '../lib/firebase';

export interface NotificationPreferences {
  deals_enabled: boolean;
  messages_enabled: boolean;
  channels_enabled: boolean;
  foreground_alerts: boolean;
  updatedAt?: string;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
  deals_enabled: true,
  messages_enabled: true,
  channels_enabled: true,
  foreground_alerts: true,
};

export interface PushNavigationPayload {
  url?: string;
  kind?: 'deal' | 'message' | 'channel' | 'wallet' | 'support' | 'system';
  contract_id?: string | null;
  scope?: 'direct' | 'contract' | null;
  chat_id?: string | null;
  channel_id?: string | null;
}

const PREFS_STORAGE_KEY = 'mianji_notif_prefs';
const ENDPOINT_STORAGE_KEY = 'mianji_push_endpoint';
const FCM_TOKEN_STORAGE_KEY = 'mianji_fcm_token';
const BANNER_DISMISSED_KEY = 'mianji_push_banner_dismissed';

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let fcmForegroundUnsub: (() => void) | null = null;

export const isBrowserPushSupported = (): boolean => {
  if (typeof window === 'undefined') return false;
  return 'Notification' in window && 'serviceWorker' in navigator;
};

export const isWebPushManagerSupported = (): boolean => {
  if (!isBrowserPushSupported()) return false;
  return 'PushManager' in window;
};

export const getBrowserNotificationPermission = (): NotificationPermission | 'unsupported' => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

export const isPushBannerDismissed = (): boolean => {
  try {
    return localStorage.getItem(BANNER_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
};

export const dismissPushBanner = () => {
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, 'true');
  } catch {}
};

export const loadCachedNotificationPrefs = (): NotificationPreferences => {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_NOTIFICATION_PREFS, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...DEFAULT_NOTIFICATION_PREFS };
};

export const cacheNotificationPrefs = (prefs: NotificationPreferences) => {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
};

const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
};

export const registerPushServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!swRegistrationPromise) {
    swRegistrationPromise = navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => reg)
      .catch(() => null);
  }
  return swRegistrationPromise;
};

export const fetchNotificationPreferences = async (): Promise<{
  prefs: NotificationPreferences;
  subscriptionsCount: number;
  hasLocalSubscription: boolean;
}> => {
  try {
    const res = await apiFetch<{
      success: boolean;
      prefs?: NotificationPreferences;
      subscriptionsCount?: number;
    }>('/api/push/preferences');

    const prefs = res?.prefs ? { ...DEFAULT_NOTIFICATION_PREFS, ...res.prefs } : loadCachedNotificationPrefs();
    cacheNotificationPrefs(prefs);

    let hasLocalSubscription = Boolean(localStorage.getItem(ENDPOINT_STORAGE_KEY) || localStorage.getItem(FCM_TOKEN_STORAGE_KEY));
    if (isWebPushManagerSupported()) {
      try {
        const reg = await registerPushServiceWorker();
        const existingSub = await reg?.pushManager?.getSubscription();
        if (existingSub) hasLocalSubscription = true;
      } catch {}
    }

    return {
      prefs,
      subscriptionsCount: Number(res?.subscriptionsCount || 0),
      hasLocalSubscription,
    };
  } catch {
    return {
      prefs: loadCachedNotificationPrefs(),
      subscriptionsCount: 0,
      hasLocalSubscription: Boolean(localStorage.getItem(ENDPOINT_STORAGE_KEY) || localStorage.getItem(FCM_TOKEN_STORAGE_KEY)),
    };
  }
};

export const saveNotificationPreferences = async (
  partial: Partial<NotificationPreferences>
): Promise<NotificationPreferences> => {
  const next = { ...loadCachedNotificationPrefs(), ...partial };
  cacheNotificationPrefs(next);
  try {
    const res = await apiFetch<{ success: boolean; prefs?: NotificationPreferences }>('/api/push/preferences', {
      method: 'PUT',
      body: JSON.stringify(next),
    });
    if (res?.prefs) {
      const merged = { ...DEFAULT_NOTIFICATION_PREFS, ...res.prefs };
      cacheNotificationPrefs(merged);
      return merged;
    }
  } catch {}
  return next;
};

export const subscribeToBrowserPush = async (): Promise<{
  success: boolean;
  permission: NotificationPermission | 'unsupported';
  mode: 'webpush+fcm' | 'webpush' | 'fcm' | 'local';
  error?: string;
}> => {
  if (!isBrowserPushSupported()) {
    return { success: false, permission: 'unsupported', mode: 'local', error: 'این مرورگر از اعلان‌های وب پشتیبانی نمی‌کند.' };
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return { success: false, permission: Notification.permission, mode: 'local', error: 'درخواست مجوز اعلان ناموفق بود.' };
    }
  }

  if (permission !== 'granted') {
    return {
      success: false,
      permission,
      mode: 'local',
      error: 'دسترسی اعلان مرورگر مسدود است. لطفاً از تنظیمات مرورگر اعلان را مجاز کنید.',
    };
  }

  const reg = await registerPushServiceWorker();
  let endpoint: string | undefined;
  let keys: { p256dh?: string; auth?: string } | undefined;
  let fcmToken: string | undefined;

  try {
    const cfg = await apiFetch<{
      success: boolean;
      publicKey?: string;
      fcmVapidKey?: string | null;
    }>('/api/push/config');

    if (reg && reg.pushManager && cfg?.publicKey) {
      try {
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(cfg.publicKey) as unknown as BufferSource,
          });
        }
        const subJson = sub.toJSON();
        endpoint = sub.endpoint;
        keys = subJson?.keys as { p256dh?: string; auth?: string } | undefined;
        if (endpoint) localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint);
      } catch {
        // Sandboxed or browser without PushService continues with FCM/SW Notification
      }
    }

    const fcmVapidKey = cfg?.fcmVapidKey || (import.meta as any).env?.VITE_FIREBASE_VAPID_KEY;
    if (fcmVapidKey && getApps().length > 0 && reg) {
      try {
        const supported = await isFcmSupported();
        if (supported) {
          const messaging = getMessaging(getApps()[0]);
          const token = await getToken(messaging, {
            vapidKey: fcmVapidKey,
            serviceWorkerRegistration: reg,
          });
          if (token) {
            fcmToken = token;
            localStorage.setItem(FCM_TOKEN_STORAGE_KEY, token);
          }
          if (!fcmForegroundUnsub) {
            fcmForegroundUnsub = onMessage(messaging, (payload) => {
              const title = payload?.notification?.title || payload?.data?.title || 'اعلان میانجی';
              const body = payload?.notification?.body || payload?.data?.body || '';
              if (title) {
                void showLocalBrowserNotification({
                  title,
                  body,
                  tag: payload?.data?.tag || `mianji-fcm-${Date.now()}`,
                  url: payload?.data?.url || '/',
                  data: payload?.data,
                });
              }
            });
          }
        }
      } catch {
        // Optional FCM token retrieval failed; Web Push / SW remains active
      }
    }
  } catch {}

  if (endpoint || fcmToken) {
    try {
      await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint,
          keys,
          fcm_token: fcmToken,
          platform: navigator.platform || 'web',
          user_agent: navigator.userAgent.slice(0, 280),
        }),
      });
    } catch {}
  }

  const mode = endpoint && fcmToken ? 'webpush+fcm' : endpoint ? 'webpush' : fcmToken ? 'fcm' : 'local';
  return { success: true, permission, mode };
};

export const unsubscribeFromBrowserPush = async (): Promise<void> => {
  const cachedEndpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY) || undefined;
  const cachedFcm = localStorage.getItem(FCM_TOKEN_STORAGE_KEY) || undefined;

  if (isWebPushManagerSupported()) {
    try {
      const reg = await registerPushServiceWorker();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) {
        await sub.unsubscribe();
      }
    } catch {}
  }

  localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  localStorage.removeItem(FCM_TOKEN_STORAGE_KEY);

  try {
    await apiFetch('/api/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: cachedEndpoint,
        fcm_token: cachedFcm,
      }),
    });
  } catch {}
};

export const syncExistingPushSubscription = async (): Promise<void> => {
  if (!isBrowserPushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await registerPushServiceWorker();
    const sub = await reg?.pushManager?.getSubscription();
    const cachedFcm = localStorage.getItem(FCM_TOKEN_STORAGE_KEY) || undefined;
    if (sub) {
      const subJson = sub.toJSON();
      localStorage.setItem(ENDPOINT_STORAGE_KEY, sub.endpoint);
      await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          endpoint: sub.endpoint,
          keys: subJson?.keys,
          fcm_token: cachedFcm,
          platform: navigator.platform || 'web',
          user_agent: navigator.userAgent.slice(0, 280),
        }),
      });
    }
  } catch {}
};

export const sendServerTestPush = async (): Promise<{ success: boolean; deliveredCount: number }> => {
  return apiFetch<{ success: boolean; deliveredCount: number }>('/api/push/test', {
    method: 'POST',
    body: JSON.stringify({}),
  });
};

export const showLocalBrowserNotification = async ({
  title,
  body,
  tag,
  url = '/',
  data = {},
  onClick,
}: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  data?: PushNavigationPayload;
  onClick?: () => void;
}): Promise<boolean> => {
  if (!isBrowserPushSupported() || Notification.permission !== 'granted') return false;

  const navData: PushNavigationPayload = { url, ...data };
  const notifTag = tag || `mianji-${Date.now()}`;

  try {
    const reg = await registerPushServiceWorker();
    if (reg && 'showNotification' in reg) {
      await reg.showNotification(title, {
        body,
        tag: notifTag,
        dir: 'rtl',
        lang: 'fa',
        data: navData,
      });
      return true;
    }
  } catch {}

  try {
    const n = new Notification(title, {
      body,
      tag: notifTag,
      dir: 'rtl',
      lang: 'fa',
    });
    n.onclick = () => {
      try {
        window.focus();
        onClick?.();
      } catch {}
      n.close();
    };
    return true;
  } catch {
    return false;
  }
};

export const subscribeToSwNotificationClicks = (
  handler: (payload: PushNavigationPayload) => void
): (() => void) => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.data?.type === 'mianji:notification-click' && event.data?.payload) {
      handler(event.data.payload);
    }
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => {
    navigator.serviceWorker.removeEventListener('message', listener);
  };
};
