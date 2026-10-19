import type { ReactNode } from "react";

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50">
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          {title && <h2 className="font-medium">{title}</h2>}
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
      <span className="text-sm font-medium text-slate-200">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500";

export function Button({
  children, onClick, disabled, variant = "primary", type = "button",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "primary" | "ghost" | "danger"; type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-700",
    ghost: "border border-slate-700 hover:bg-slate-800 text-slate-200",
    danger: "border border-red-800 text-red-300 hover:bg-red-950",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${styles}`}
    >
      {children}
    </button>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-red-400">{children}</p>;
}
