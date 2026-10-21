import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client.ts";
import { TERMINAL } from "./api/types.ts";
import DiskBanner from "./components/DiskBanner.tsx";
import { Icon, type IconName } from "./components/Icon.tsx";
import NewRun from "./pages/NewRun.tsx";
import Jobs from "./pages/Jobs.tsx";
import Library from "./pages/Library.tsx";
import Meeting from "./pages/Meeting.tsx";
import Settings from "./pages/Settings.tsx";
import Health from "./pages/Health.tsx";
import Search from "./pages/Search.tsx";

const NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "New run", icon: "plus" },
  { href: "/jobs", label: "Jobs", icon: "jobs" },
  { href: "/library", label: "Library", icon: "library" },
];

function isActive(location: string, href: string): boolean {
  return href === "/" ? location === "/" : location.startsWith(href);
}

/** Header search: Enter opens the Search page; "/" focuses it from anywhere. */
function HeaderSearch() {
  const [, navigate] = useLocation();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
    ref.current?.blur();
  };

  return (
    <form
      onSubmit={submit}
      className="flex h-8 w-64 items-center gap-2 rounded-lg bg-white/[0.04] px-3 text-sm ring-1 ring-inset ring-white/[0.06] focus-within:ring-indigo-500/60"
    >
      <Icon name="search" className="h-4 w-4 shrink-0 text-zinc-500" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search transcripts"
        className="min-w-0 flex-1 bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      <kbd className="rounded bg-white/[0.06] px-1.5 font-sans text-[11px] text-zinc-400">/</kbd>
    </form>
  );
}

/** Green when the driver reports a GPU; amber links to Health when it does not. */
function GpuPill() {
  const { data } = useQuery({ queryKey: ["gpu"], queryFn: api.gpu, staleTime: Infinity });
  if (!data) return null;
  if (!data.gpu) {
    return (
      <Link href="/health" className="flex items-center gap-2 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />CPU only
      </Link>
    );
  }
  return (
    <span
      title={`${data.gpu.name}, ${data.gpu.vramGb} GB`}
      className="flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" />GPU ready
    </span>
  );
}

export default function App() {
  const [location] = useLocation();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 5000 });
  const running = jobs.data?.jobs.some((j) => !TERMINAL.includes(j.state)) ?? false;

  const iconLink = (href: string, icon: IconName, label: string) => (
    <Link
      href={href}
      title={label}
      className={`grid h-8 w-8 place-items-center rounded-lg transition ${
        isActive(location, href) ? "bg-white/[0.08] text-zinc-50" : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100"
      }`}
    >
      <Icon name={icon} />
    </Link>
  );

  return (
    <div className="relative min-h-full">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(ellipse_70%_60%_at_50%_-10%,rgba(99,102,241,0.18),transparent)]" />

      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-[#09090b]/75 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-8 px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/30">
              <Icon name="logo" className="h-4 w-4 text-white" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">whisper-generator</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 transition ${
                  isActive(location, item.href) ? "bg-white/[0.08] text-zinc-50" : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                <Icon name={item.icon} />
                {item.label}
                {item.href === "/jobs" && running && (
                  <span className="relative flex h-2 w-2" title="A job is running">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
                  </span>
                )}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <HeaderSearch />
            <span className="ml-2"><GpuPill /></span>
            {iconLink("/health", "health", "Health")}
            {iconLink("/settings", "settings", "Settings")}
          </div>
        </div>
      </header>

      <DiskBanner />

      <main className="relative mx-auto w-full max-w-[1280px] px-8 pb-10 pt-7">
        <Switch>
          <Route path="/" component={NewRun} />
          <Route path="/jobs" component={Jobs} />
          <Route path="/library" component={Library} />
          <Route path="/library/:dir" component={Meeting} />
          <Route path="/search" component={Search} />
          <Route path="/settings" component={Settings} />
          <Route path="/health" component={Health} />
          <Route>Not found.</Route>
        </Switch>
      </main>
    </div>
  );
}
