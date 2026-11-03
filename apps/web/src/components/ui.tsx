import { type ReactNode, useEffect, useRef } from 'react';

/** The app's one loading indicator: the thinking orb, with what's happening. */
export function OrbLoader({ message }: { message?: string }) {
  return (
    <div className="orb-loader" role="status" aria-live="polite">
      <div className="orb" aria-hidden="true" />
      {message && <div className="secondary">{message}</div>}
    </div>
  );
}

export function SmallOrb({ label }: { label: string }) {
  return <span className="orb small" role="status" aria-label={label} />;
}

/** Inset-grouped section: a small header, rows in one card, an optional footer. */
export function Section({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section>
      {header && <h2 className="section-header">{header}</h2>}
      <div className="card">{children}</div>
      {footer && <p className="footer">{footer}</p>}
    </section>
  );
}

/** A sheet (glass functional layer) as a modal dialog: Escape and the backdrop close it. */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet glass"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="sheet-body">
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close" type="button">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

const paths: Record<string, string> = {
  dashboard: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
  diary: 'M4 6h16M4 12h16M4 18h10',
  recipes: 'M4 11h16a8 8 0 0 1-16 0zm4-4c0-1.5 1-2 1-3m3 3c0-1.5 1-2 1-3m3 3c0-1.5 1-2 1-3',
  weight: 'M12 3a9 9 0 0 0-9 9h4a5 5 0 0 1 10 0h4a9 9 0 0 0-9-9zm0 9 3-4',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  add: 'M12 5v14M5 12h14',
};

export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
