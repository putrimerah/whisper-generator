import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

/** Surface used by every panel: a faint fill and a hairline inner ring. */
export const surfaceClass = "rounded-2xl bg-zinc-900/40 ring-1 ring-inset ring-white/[0.06]";

export function Card({
  title, children, actions, className = "",
}: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`${surfaceClass} ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-5 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-200">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg bg-black/30 px-3 py-2 text-sm text-zinc-100 outline-none ring-1 ring-inset ring-white/[0.08] placeholder:text-zinc-500 focus:ring-indigo-500/60";

type Variant = "primary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-gradient-to-b from-indigo-500 to-violet-600 font-semibold text-white shadow-lg shadow-indigo-600/25 ring-1 ring-inset ring-white/20 hover:from-indigo-400 hover:to-violet-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:shadow-none",
  ghost: "font-medium text-zinc-200 ring-1 ring-inset ring-white/10 hover:bg-white/[0.06]",
  danger: "font-medium text-red-300 ring-1 ring-inset ring-red-500/30 hover:bg-red-500/10",
};

/** Shared by <Button> and by links that should look like one. */
export function buttonClass(variant: Variant = "primary"): string {
  return `inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 text-sm transition disabled:cursor-not-allowed ${VARIANTS[variant]}`;
}

export function Button({
  children, onClick, disabled, variant = "primary", type = "button", icon, title,
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: Variant; type?: "button" | "submit"; icon?: IconName; title?: string;
}) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={buttonClass(variant)}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-red-400">{children}</p>;
}

/** Small uppercase label above a group inside a card. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{children}</p>;
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) {
  const tones = {
    neutral: "bg-white/[0.05] text-zinc-200 ring-white/[0.08]",
    accent: "bg-indigo-500/10 text-indigo-200 ring-indigo-400/20",
  };
  return <span className={`rounded-md px-2 py-1 text-xs ring-1 ring-inset ${tones[tone]}`}>{children}</span>;
}

/** Dropdown: closes on outside click and on Escape. */
export function Menu({ label, icon, children }: { label: string; icon?: IconName; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" className={buttonClass("ghost")} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {icon && <Icon name={icon} />}
        {label}
        <Icon name="chevronDown" className="h-4 w-4 text-zinc-500" />
      </button>
      {open && (
        <div
          className="absolute right-0 z-30 mt-2 w-64 overflow-hidden rounded-xl bg-zinc-900 p-1 shadow-2xl shadow-black/60 ring-1 ring-white/10"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children, onClick, href, icon, hint, download,
}: {
  children: ReactNode; onClick?: () => void; href?: string; icon?: IconName; hint?: string; download?: boolean;
}) {
  const cls = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 hover:bg-white/[0.06]";
  const body = (
    <>
      {icon && <Icon name={icon} className="h-4 w-4 text-zinc-500" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="tnum shrink-0 font-mono text-[11px] text-zinc-500">{hint}</span>}
    </>
  );
  return href ? (
    <a href={href} className={cls} download={download}>{body}</a>
  ) : (
    <button type="button" className={cls} onClick={onClick}>{body}</button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-white/[0.06]" />;
}
