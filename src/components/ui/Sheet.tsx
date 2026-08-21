import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Wider panel for editors and inspectors. */
  large?: boolean;
  /** Hides the close button — use for blocking dialogs. */
  hideClose?: boolean;
  labelledBy?: string;
}

/**
 * One component serves as both the mobile bottom sheet and the desktop modal;
 * the difference is entirely CSS. Focus is trapped, Escape closes, and the
 * body scroll is locked while open.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  large,
  hideClose,
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first sensible control without stealing from an autofocus.
    const timer = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const target = panel.querySelector<HTMLElement>(
        '[data-autofocus], input:not([type=hidden]), textarea, select, button',
      );
      (target ?? panel).focus({ preventScroll: true });
    }, 40);

    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  const onOverlayClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className="overlay" onMouseDown={onOverlayClick}>
      <div
        className={`sheet${large ? ' sheet-lg' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <div className="sheet-header">
          <h2 id={titleId}>{title}</h2>
          {!hideClose && (
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          )}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction {
  key: string;
  label: string;
  description?: string;
  icon?: string;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** Touch-friendly action menu; replaces hover menus and right-click. */
export function ActionSheet({
  open,
  onClose,
  title,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  actions: SheetAction[];
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="action-list">
        {actions.map((action) => (
          <div key={action.key}>
            {action.separatorBefore && <div className="action-sep" role="separator" />}
            <button
              type="button"
              className={action.destructive ? 'destructive' : undefined}
              disabled={action.disabled}
              onClick={() => {
                onClose();
                // Let the sheet unmount before the action opens another one.
                setTimeout(action.onSelect, 0);
              }}
            >
              {action.icon && <Icon name={action.icon} />}
              <span>
                {action.label}
                {action.description && <span className="action-desc">{action.description}</span>}
              </span>
            </button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
