import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, formatBytes, formatDuration } from "../api/client.ts";
import ChipInput from "../components/ChipInput.tsx";
import FilePicker from "../components/FilePicker.tsx";
import { Button, Card, ErrorText, Field, inputClass } from "../components/Ui.tsx";

const MODELS = ["tiny", "base", "small", "medium", "large-v3", "turbo"];
const COMPUTE = ["int8_float16", "int8", "float16", "float32", "auto"];

/**
 * Quality presets instead of a raw quantization dropdown. "Best" fits
 * large-v3 into 6 GB of VRAM while leaving room for the display.
 */
const PRESETS = [
  {
    id: "best",
    label: "Best",
    hint: "large-v3, highest accuracy, handles Malay mixed with English. ~2.3x realtime.",
    model: "large-v3",
    computeType: "int8_float16",
  },
  {
    id: "faster",
    label: "Faster",
    hint: "medium model, roughly 3x quicker, weaker on Malay and names.",
    model: "medium",
    computeType: "int8",
  },
  {
    id: "compatibility",
    label: "Maximum compatibility",
    hint: "small model, lowest memory. Use only if the GPU runs out of memory.",
    model: "small",
    computeType: "int8",
  },
] as const;
const LANGUAGES = [
  { value: "en", label: "English (forced)" },
  { value: "ms", label: "Malay (forced)" },
  { value: "auto", label: "Auto-detect" },
];

export default function NewRun() {
  const [, navigate] = useLocation();
  const configQuery = useQuery({ queryKey: ["config"], queryFn: api.config });
  const meetingsQuery = useQuery({ queryKey: ["meetings", ""], queryFn: () => api.meetings("") });
  const config = configQuery.data?.config;

  const [input, setInput] = useState<string | null>(null);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [preset, setPreset] = useState<string>("best");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [model, setModel] = useState("large-v3");
  const [language, setLanguage] = useState("en");
  const [computeType, setComputeType] = useState("int8_float16");
  const [keepAudio, setKeepAudio] = useState(false);
  const [wordTimestamps, setWordTimestamps] = useState(false);
  const [diarize, setDiarize] = useState(false);
  const [speakerCount, setSpeakerCount] = useState(0);
  const [outDir, setOutDir] = useState("");
  const [showOutPicker, setShowOutPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (id: string) => {
    setPreset(id);
    const found = PRESETS.find((p) => p.id === id);
    if (!found) return;
    setModel(found.model);
    setComputeType(found.computeType);
  };

  useEffect(() => {
    if (!config) return;
    setModel(config.model);
    setLanguage(config.language);
    setComputeType(config.computeType);
    setKeepAudio(config.keepAudio);
    setWordTimestamps(config.wordTimestamps);
  }, [config]);

  const probe = useQuery({
    queryKey: ["probe", input],
    queryFn: () => api.probe(input as string),
    enabled: input !== null,
  });

  const [prompt, setPrompt] = useState<{ tokens: number; budget: number; truncated: boolean; dropped: string[]; prompt: string } | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      void api.prompt({ context, attendees, terms }).then(setPrompt).catch(() => setPrompt(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [context, attendees, terms]);

  const knownAttendees = useMemo(() => {
    const set = new Set<string>(config?.attendees ?? []);
    for (const m of meetingsQuery.data?.meetings ?? []) {
      for (const a of m.record.attendees) set.add(a);
    }
    return [...set];
  }, [config, meetingsQuery.data]);

  const knownTerms = useMemo(() => {
    const set = new Set<string>(config?.terms ?? []);
    for (const m of meetingsQuery.data?.meetings ?? []) {
      for (const t of m.record.terms) set.add(t);
    }
    return [...set];
  }, [config, meetingsQuery.data]);

  const create = useMutation({
    mutationFn: () =>
      api.createJob({
        input,
        attendees,
        terms,
        context,
        model,
        language,
        computeType,
        keepAudio,
        wordTimestamps,
        diarize,
        speakerCount,
        ...(outDir.trim() === "" ? {} : { outDir }),
      }),
    onSuccess: () => navigate("/jobs"),
    onError: (err: Error) => setError(err.message),
  });

  const meterPercent = prompt ? Math.min(100, (prompt.tokens / prompt.budget) * 100) : 0;
  const meterColor = !prompt
    ? "bg-zinc-700"
    : prompt.truncated
      ? "bg-red-500"
      : prompt.tokens > 180
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="space-y-5">
      <Card title="1 · Source recording">
        <FilePicker value={input} onPick={setInput} />
        {input && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="font-mono text-sm text-zinc-200">{input}</p>
            {probe.isLoading && <p className="mt-1 text-xs text-zinc-400">Probing…</p>}
            {probe.error && <ErrorText>{(probe.error as Error).message}</ErrorText>}
            {probe.data && (
              <dl className="mt-2 grid grid-cols-4 gap-3 text-sm">
                <div><dt className="text-xs text-zinc-400">Duration</dt><dd>{formatDuration(probe.data.durationSeconds)}</dd></div>
                <div><dt className="text-xs text-zinc-400">Size</dt><dd>{formatBytes(probe.data.sizeBytes)}</dd></div>
                <div><dt className="text-xs text-zinc-400">Audio</dt><dd>{probe.data.audioCodec ?? "—"}</dd></div>
                <div><dt className="text-xs text-zinc-400">Est. transcription</dt><dd>~{formatDuration(probe.data.estimatedTranscribeSeconds)}</dd></div>
              </dl>
            )}
          </div>
        )}
      </Card>

      <Card title="2 · Meeting details">
        <div className="space-y-4">
          <Field label="Attendees" hint="Names appear in the prompt so Whisper spells them correctly.">
            <ChipInput value={attendees} onChange={setAttendees} placeholder="Alice, Bob…" suggestions={knownAttendees} />
          </Field>

          <Field label="Context">
            <textarea
              className={inputClass}
              rows={3}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="One or two sentences: what this meeting is about."
            />
          </Field>

          <Field label="Glossary terms" hint="Project names, acronyms, Malay words — anything Whisper would otherwise spell phonetically.">
            <ChipInput value={terms} onChange={setTerms} placeholder="Kafka, Atlas…" suggestions={knownTerms} />
          </Field>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Whisper prompt</span>
              <span className={prompt?.truncated ? "text-red-400" : "text-zinc-400"}>
                {prompt ? `${prompt.tokens} / ${prompt.budget} tokens` : "…"}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full ${meterColor}`} style={{ width: `${meterPercent}%` }} />
            </div>
            {prompt && prompt.dropped.length > 0 && (
              <p className="mt-2 text-xs text-red-300">
                Over budget — these were dropped: {prompt.dropped.join(", ")}. Names and terms are kept.
              </p>
            )}
            {prompt && (
              <p className="mt-2 font-mono text-xs leading-relaxed text-zinc-400">{prompt.prompt}</p>
            )}
          </div>
        </div>
      </Card>

      <Card title="3 · Processing">
        <div className="space-y-4">
          <p className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
            Audio is extracted from the recording into WSL. Your Windows file is read only and is
            never moved, changed, or deleted.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Quality">
              <select className={inputClass} value={preset} onChange={(e) => applyPreset(e.target.value)}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                <option value="custom">Custom (set in Advanced)</option>
              </select>
            </Field>
            <Field label="Language">
              <select className={inputClass} value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
          </div>
          <p className="text-xs text-zinc-400">
            {PRESETS.find((p) => p.id === preset)?.hint ??
              `Custom: ${model} at ${computeType}.`}
          </p>

          <div className="flex gap-6 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} />
              Keep extracted audio
              <span className="text-xs text-zinc-400">(~115 MB/hour, lets a re-run skip ffmpeg)</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={wordTimestamps} onChange={(e) => setWordTimestamps(e.target.checked)} />
              Word timestamps
              <span className="text-xs text-zinc-400">(known crash; retried without automatically)</span>
            </label>
          </div>

          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={diarize}
                disabled={!config?.hfToken}
                onChange={(e) => setDiarize(e.target.checked)}
              />
              Label speakers (diarization)
              {!config?.hfToken && (
                <span className="text-xs text-amber-300">
                  needs a HuggingFace token in Settings
                </span>
              )}
            </label>
            {diarize && (
              <label className="flex items-center gap-2 text-sm">
                Known speaker count
                <input
                  type="number"
                  min={0}
                  className={`${inputClass} w-24`}
                  value={speakerCount}
                  onChange={(e) => setSpeakerCount(Number(e.target.value))}
                />
                <span className="text-xs text-zinc-400">0 = let pyannote decide</span>
              </label>
            )}
          </div>

          <Field label="Output folder" hint={`Default: ${config?.outputRoot ?? "…"}/<name>`}>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={outDir}
                placeholder="leave empty for the default"
                onChange={(e) => setOutDir(e.target.value)}
              />
              <Button variant="ghost" onClick={() => setShowOutPicker((v) => !v)}>
                {showOutPicker ? "Close" : "Browse"}
              </Button>
            </div>
          </Field>
          {showOutPicker && (
            <FilePicker
              dirsOnly
              value={outDir}
              onPick={(p) => {
                setOutDir(p);
                setShowOutPicker(false);
              }}
            />
          )}

          <div className="rounded-lg border border-zinc-800">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-2 text-sm text-zinc-300"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              <span>Advanced</span>
              <span className="text-xs text-zinc-500">{showAdvanced ? "hide" : "show"}</span>
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 gap-4 border-t border-zinc-800 p-4">
                <Field label="Model">
                  <select
                    className={inputClass}
                    value={model}
                    onChange={(e) => { setModel(e.target.value); setPreset("custom"); }}
                  >
                    {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </Field>
                <Field
                  label="Compute type"
                  hint="Number precision. int8_float16 fits large-v3 in 6 GB of VRAM; float16 is marginally more accurate but risks running out of memory."
                >
                  <select
                    className={inputClass}
                    value={computeType}
                    onChange={(e) => { setComputeType(e.target.value); setPreset("custom"); }}
                  >
                    {COMPUTE.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </div>

          <ErrorText>{error}</ErrorText>
          <Button disabled={!input || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Starting…" : "Start transcription"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
