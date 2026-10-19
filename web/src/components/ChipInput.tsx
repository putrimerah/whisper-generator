import { useState, type KeyboardEvent } from "react";
import { inputClass } from "./Ui.tsx";

/** Enter or comma commits; Backspace on an empty field removes the last chip. */
export default function ChipInput({
  value, onChange, placeholder, suggestions = [],
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");

  const commit = (raw: string) => {
    const name = raw.trim().replace(/,$/, "");
    if (name === "") return;
    if (value.some((v) => v.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, name]);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const unused = suggestions.filter(
    (s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()),
  );

  return (
    <div className="space-y-2">
      <div className={`${inputClass} flex flex-wrap items-center gap-1.5`}>
        {value.map((chip) => (
          <span
            key={chip}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600/20 px-2 py-0.5 text-xs text-indigo-200"
          >
            {chip}
            <button
              type="button"
              className="text-indigo-300 hover:text-white"
              onClick={() => onChange(value.filter((v) => v !== chip))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[8rem] bg-transparent outline-none"
          value={draft}
          placeholder={value.length === 0 ? placeholder : ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
        />
      </div>
      {unused.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {unused.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => commit(s)}
              className="rounded-md border border-slate-700 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-800"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
