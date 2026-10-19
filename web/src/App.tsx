import { Link, Route, Switch, useLocation } from "wouter";
import DiskBanner from "./components/DiskBanner.tsx";
import NewRun from "./pages/NewRun.tsx";
import Jobs from "./pages/Jobs.tsx";
import Library from "./pages/Library.tsx";
import Meeting from "./pages/Meeting.tsx";
import Settings from "./pages/Settings.tsx";
import Health from "./pages/Health.tsx";
import Search from "./pages/Search.tsx";

const NAV = [
  { href: "/", label: "New run" },
  { href: "/jobs", label: "Jobs" },
  { href: "/library", label: "Library" },
  { href: "/search", label: "Search" },
  { href: "/settings", label: "Settings" },
  { href: "/health", label: "Health" },
];

export default function App() {
  const [location] = useLocation();
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/60 backdropur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-6">
          <span className="font-semibold tracking-tight">whisper-generator</span>
          <nav className="flex gap-1 text-sm">
            {NAV.map((item) => {
              const active =
                item.href === "/" ? location === "/" : location.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md transition ${
                    active ? "bg-indigo-600 text-white" : "text-slate-300 hover:bg-slate-800"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <DiskBanner />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
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
