import React, { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    const isTelegramWebView = /telegram/i.test(ua) || Boolean((window as any).Telegram?.WebApp?.initData);
    setIsIOS(/iphone|ipad|ipod/.test(ua) && !isTelegramWebView);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}

export const PWAInstallButton: React.FC<{ variant?: 'sidebar' | 'card' }> = ({ variant = 'sidebar' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;
  if (!isInstallable && !isIOS) return null;

  const baseClass =
    variant === 'card'
      ? 'w-full h-11 rounded-2xl bg-blue-600/10 hover:bg-blue-600/15 border border-blue-500/25 text-blue-600 dark:text-blue-300 font-black text-xs flex items-center justify-center gap-2 transition-all active:scale-95'
      : 'w-full h-10 rounded-xl bg-blue-600/10 hover:bg-blue-600/15 border border-blue-500/20 text-blue-600 dark:text-blue-300 font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95';

  return (
    <>
      <button
        type="button"
        onClick={() => (isInstallable ? void install() : setShowIOSGuide(true))}
        className={baseClass}
      >
        {isInstallable ? <Download size={15} /> : <Share size={15} />}
        <span>{isInstallable ? 'نصب اپلیکیشن میانجی' : 'افزودن به صفحه اصلی (iOS)'}</span>
      </button>

      {showIOSGuide && (
        <div
          onClick={() => setShowIOSGuide(false)}
          className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/70 backdrop-blur-sm p-5"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl bg-white dark:bg-[#131924] border border-slate-200 dark:border-white/[0.08] p-6 shadow-2xl space-y-4 text-right"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-slate-900 dark:text-white">نصب روی آیفون و آیپد</h3>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-8 h-8 rounded-full bg-slate-100 dark:bg-white/10 flex items-center justify-center text-slate-600 dark:text-white"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              <p>۱. در نوار پایین مرورگر Safari دکمه <strong>Share</strong> (مربع با فلش بالا) را بزنید.</p>
              <p>۲. به پایین اسکرول کرده و گزینه <strong>Add to Home Screen</strong> را انتخاب کنید.</p>
              <p>۳. در بالا دکمه <strong>Add</strong> را بزنید تا آیکون میانجی روی گوشی نصب شود.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowIOSGuide(false)}
              className="w-full h-11 rounded-xl bg-blue-600 text-white text-xs font-black"
            >
              متوجه شدم
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[1500] flex items-center gap-2 rounded-xl bg-amber-500 px-3.5 py-2 text-[11px] font-black text-slate-950 shadow-lg">
      <span className="h-2 w-2 rounded-full bg-slate-950 animate-pulse" />
      اتصال اینترنت قطع است — در حال نمایش داده‌های ذخیره‌شده
    </div>
  );
};
