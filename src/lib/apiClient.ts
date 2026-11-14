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

async function compressImageIfNeeded(fileOrBlob: Blob): Promise<{ blob: Blob; mimeType: string }> {
  const mime = fileOrBlob.type || 'application/octet-stream';
  if (
    typeof document === 'undefined' ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(mime) ||
    fileOrBlob.size <= 350 * 1024
  ) {
    return { blob: fileOrBlob, mimeType: mime };
  }

  try {
    const imgUrl = URL.createObjectURL(fileOrBlob);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = imgUrl;
    });
    URL.revokeObjectURL(imgUrl);

    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { blob: fileOrBlob, mimeType: mime };
    ctx.drawImage(img, 0, 0, width, height);

    const compressed = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.82)
    );
    if (compressed && compressed.size < fileOrBlob.size) {
      return { blob: compressed, mimeType: 'image/webp' };
    }
  } catch {}
  return { blob: fileOrBlob, mimeType: mime };
}

export async function uploadMediaFile(fileOrBlob: Blob, filename?: string): Promise<string> {
  if (fileOrBlob.size > 5 * 1024 * 1024) {
    throw new Error('حجم فایل نباید بیشتر از ۵ مگابایت باشد.');
  }
  const resolvedName = filename || (typeof File !== 'undefined' && fileOrBlob instanceof File ? fileOrBlob.name : 'media-upload');

  const { blob, mimeType } = await compressImageIfNeeded(fileOrBlob);
  if (blob.size > 5 * 1024 * 1024) {
    throw new Error('حجم فایل پس از بهینه‌سازی همچنان بیشتر از ۵ مگابایت است.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('خطا در خواندن فایل'));
    };
    reader.onerror = () => reject(new Error('خطا در خواندن فایل'));
    reader.readAsDataURL(blob);
  });

  const res = await apiFetch<{ success: boolean; url: string }>('/api/media', {
    method: 'POST',
    body: JSON.stringify({
      dataUrl,
      filename: resolvedName,
      mimeType,
    }),
  });

  return res.url;
}
