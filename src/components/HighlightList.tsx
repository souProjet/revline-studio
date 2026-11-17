"use client";

import { heat } from "@/lib/heat";
import type { ClipTag, SmartClip } from "@/lib/types";

const TAG_NAME: Record<ClipTag, string> = {
  RPM_PEAK: "RPM peak",
  POPS_BANGS: "Pops & bangs",
  MAX_LEAN: "Max lean",
  VOICE: "Voice",
};

export const fmtTime = (ms: number) => {
  const s = Math.max(0, ms / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

interface Props {
  clips: SmartClip[];
  actionScore: number[];
  selectedId: string | null;
  queued: Set<string>;
  onSelect: (id: string) => void;
  onToggleQueue: (id: string, on: boolean) => void;
}

/** Each row carries the clip's own Action Score profile as a heat-tint strip. */
export default function HighlightList({ clips, actionScore, selectedId, queued, onSelect, onToggleQueue }: Props) {
  return (
    <ul className="divide-y divide-hairline" aria-label="Highlights">
      {clips.map((c) => {
        const selected = c.id === selectedId;
        const seconds = actionScore.slice(Math.floor(c.start_ms / 1000), Math.ceil(c.end_ms / 1000));
        return (
          <li key={c.id} className={`relative ${selected ? "bg-raised" : "hover:bg-[#27282b]"}`}>
            {selected && <span className="absolute inset-y-0 left-0 w-[3px] bg-straw" aria-hidden />}
            <div className="flex items-start gap-3 py-3 pl-4 pr-3">
              <button type="button" onClick={() => onSelect(c.id)} aria-current={selected} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-cond text-[19px] font-semibold leading-tight tracking-[0.01em] text-fg">
                  {c.label}
                </span>
                <span className="mt-0.5 block text-[12px] text-muted">
                  <span className="font-mono">{fmtTime(c.start_ms)}</span>
                  <span className="ml-2">{Math.round((c.end_ms - c.start_ms) / 1000)} s</span>
                  {c.tags.length > 0 && <span className="ml-2">{c.tags.map((t) => TAG_NAME[t]).join(", ")}</span>}
                </span>
                <span className="mt-2 flex h-1.5 gap-px overflow-hidden rounded-[1px]" aria-hidden>
                  {seconds.map((s, i) => (
                    <span key={i} className="flex-1" style={{ background: heat(s / 100), opacity: 0.35 + (0.65 * s) / 100 }} />
                  ))}
                </span>
              </button>
              <div className="flex flex-col items-end gap-2">
                <span className="font-cond text-[24px] font-bold leading-none" style={{ color: heat(c.score / 100) }}>
                  {Math.round(c.score)}
                </span>
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[#e0b85c]"
                    checked={queued.has(c.id)}
                    onChange={(e) => onToggleQueue(c.id, e.target.checked)}
                  />
                  Render
                </label>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
