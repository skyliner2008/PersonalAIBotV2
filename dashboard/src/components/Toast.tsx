import { useState, useEffect, createContext, useContext, useCallback, ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration?: number;
}

interface ToastContextType {
  addToast: (type: ToastType, message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

let _nextId = 0;

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string, duration = 4000) => {
    const id = ++_nextId;
    setToasts(prev => [...prev, { id, type, message, duration }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast Container */}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onClose={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const iconMap: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const colorMap: Record<ToastType, string> = {
  success: 'border-green-500/50 bg-green-500/10 text-green-300',
  error: 'border-red-500/50 bg-red-500/10 text-red-300',
  info: 'border-blue-500/50 bg-blue-500/10 text-blue-300',
  warning: 'border-yellow-500/50 bg-yellow-500/10 text-yellow-300',
};

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const Icon = iconMap[toast.type];

  useEffect(() => {
    if (toast.duration && toast.duration > 0) {
      const timer = setTimeout(() => onClose(toast.id), toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.id, toast.duration, onClose]);

  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-lg animate-slide-in ${colorMap[toast.type]}`}>
      <Icon className="w-5 h-5 mt-0.5 shrink-0" />
      <p className="text-sm flex-1">{toast.message}</p>
      <button
        onClick={() => onClose(toast.id)}
        className="text-gray-400 hover:text-white transition-colors shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
