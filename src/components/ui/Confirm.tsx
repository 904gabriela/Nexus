/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Requires typing this exact text before confirming (wipes, restores). */
  typeToConfirm?: string;
}

type Resolver = (value: boolean) => void;

const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

/** Every destructive action routes through this. */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used inside <ConfirmProvider>.');
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ options: ConfirmOptions; resolve: Resolver } | null>(null);
  const [typed, setTyped] = useState('');

  const confirm = useCallback((options: ConfirmOptions) => {
    setTyped('');
    return new Promise<boolean>((resolve) => setRequest({ options, resolve }));
  }, []);

  const close = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
    setTyped('');
  };

  const value = useMemo(() => confirm, [confirm]);
  const options = request?.options;
  const needsTyping = !!options?.typeToConfirm;
  const canConfirm = !needsTyping || typed.trim() === options!.typeToConfirm;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <Sheet
        open={!!request}
        onClose={() => close(false)}
        title={options?.title ?? ''}
        footer={
          <>
            <button type="button" className="btn" onClick={() => close(false)}>
              {options?.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={`btn ${options?.destructive ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => close(true)}
              disabled={!canConfirm}
              data-autofocus
            >
              {options?.confirmLabel ?? 'Confirm'}
            </button>
          </>
        }
      >
        {options?.message && <div className="stack">{options.message}</div>}
        {needsTyping && (
          <div className="field" style={{ marginTop: 14 }}>
            <label className="field-label" htmlFor="confirm-type">
              Type <code className="mono">{options!.typeToConfirm}</code> to continue
            </label>
            <input
              id="confirm-type"
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
      </Sheet>
    </ConfirmContext.Provider>
  );
}

/** Small helper for the very common "delete X?" case. */
export function deleteConfirm(kind: string, name: string, extra?: ReactNode): ConfirmOptions {
  return {
    title: `Delete this ${kind}?`,
    message: (
      <>
        <p style={{ margin: 0 }}>
          <strong>{name || `Untitled ${kind}`}</strong> will be permanently deleted.
        </p>
        {extra}
        <p className="small muted" style={{ margin: 0 }}>
          This cannot be undone.
        </p>
      </>
    ),
    confirmLabel: 'Delete',
    destructive: true,
  };
}
