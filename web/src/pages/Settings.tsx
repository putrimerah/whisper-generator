import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import ChipInput from "../components/ChipInput.tsx";
import { Button, Card, Field, inputClass } from "../components/Ui.tsx";
import type { Config } from "../api/types.ts";

export default function Settings() {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ["config"], queryFn: api.config });
  const [draft, setDraft] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (configQuery.data) setDraft(configQuery.data.config);
  }, [configQuery.data]);

  const save = useMutation({
    mutationFn: () => api.saveConfig(draft as Partial<Config>),
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  if (!draft) return <Card><p className="text-sm text-slate-400">Loading…</p></Card>;
  const set = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft({ ...draft, [key]: value });

  return (
    <div className="space-y-4">
      <Card title="Output">
        <Field label="Output root" hint="Windows paths are accepted: C:\Users\you\Documents\transcripts">
          <input className={inputClass} value={draft.outputRoot} onChange={(e) => set("outputRoot", e.target.value)} />
        </Field>
      </Card>

      <Card title="Model">
        <div className="grid grid-cols-3 gap-4">
          <Field label="Model"><input className={inputClass} value={draft.model} onChange={(e) => set("model", e.target.value)} /></Field>
          <Field label="Language"><input className={inputClass} value={draft.language} onChange={(e) => set("language", e.target.value)} /></Field>
          <Field label="Compute type"><input className={inputClass} value={draft.computeType} onChange={(e) => set("computeType", e.target.value)} /></Field>
        </div>
      </Card>

      <Card title="Speakers (diarization)">
        <div className="space-y-4">
          <Field
            label="HuggingFace token"
            hint="Needed for pyannote speaker labels. Accept the pyannote/speaker-diarization licence on huggingface.co first. Stored locally in wg.config.json."
          >
            <input
              className={inputClass}
              type="password"
              value={draft.hfToken}
              placeholder="hf_..."
              onChange={(e) => set("hfToken", e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.diarize}
              disabled={draft.hfToken === ""}
              onChange={(e) => set("diarize", e.target.checked)}
            />
            Diarize by default
          </label>
        </div>
      </Card>

      <Card title="Defaults">
        <div className="space-y-4">
          <Field label="Default attendees">
            <ChipInput value={draft.attendees} onChange={(v) => set("attendees", v)} placeholder="Add a name…" />
          </Field>
          <Field label="Glossary terms" hint="Applied to every run. Fix a phonetic misspelling once, forever.">
            <ChipInput value={draft.terms} onChange={(v) => set("terms", v)} placeholder="Add a term…" />
          </Field>
          <Field label="Default context">
            <input className={inputClass} value={draft.context} onChange={(e) => set("context", e.target.value)} />
          </Field>
          <div className="flex gap-6 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.keepAudio} onChange={(e) => set("keepAudio", e.target.checked)} />
              Keep extracted audio
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.wordTimestamps} onChange={(e) => set("wordTimestamps", e.target.checked)} />
              Word timestamps
            </label>
          </div>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>Save settings</Button>
        {saved && <span className="text-sm text-emerald-300">Saved.</span>}
      </div>
    </div>
  );
}
