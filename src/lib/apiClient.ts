import { auth } from './firebase';

export async function getAuthHeaders(includeJson = true): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const sessionToken = localStorage.getItem('mianji_session_token');
    if (sessionToken) {
      headers['x-session-token'] = sessionToken;
    }
  } catch {}

  try {
    if (auth.currentUser) {
      const idToken = await auth.currentUser.getIdToken();
      if (idToken) {
        headers['Authorization'] = `Bearer ${idToken}`;
      }
    }
  } catch {}

  try {
    const savedUser = localStorage.getItem('mianji_mock_user');
    if (savedUser) {
      const parsed = JSON.parse(savedUser);
      if (parsed?.id) {
        headers['x-preview-user-id'] = String(parsed.id);
        if (parsed.role === 'owner' || parsed.role === 'admin') {
          headers['x-preview-admin-id'] = String(parsed.id);
        }
      }
    }
  } catch {}

  return headers;
}

export async function apiFetch<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const baseHeaders = await getAuthHeaders(!isFormData);
  const res = await fetch(url, {
    ...options,
    headers: {
      ...baseHeaders,
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('پاسخ نامعتبر از سرور دریافت شد.');
  }

  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `خطای سرور (${res.status})`);
  }

  return data as T;
}

export async function uploadMediaFile(fileOrBlob: Blob, filename: string): Promise<string> {
  if (fileOrBlob.size > 1.8 * 1024 * 1024) {
    throw new Error('حجم فایل نباید بیشتر از ۱.۸ مگابایت باشد.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('خطا در خواندن فایل'));
    };
    reader.onerror = () => reject(new Error('خطا در خواندن فایل'));
    reader.readAsDataURL(fileOrBlob);
  });

  const res = await apiFetch<{ success: boolean; url: string }>('/api/media', {
    method: 'POST',
    body: JSON.stringify({
      dataUrl,
      filename,
      mimeType: fileOrBlob.type || 'application/octet-stream',
    }),
  });

  return res.url;
}
