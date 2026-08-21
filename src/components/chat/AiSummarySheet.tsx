import { useMemo, useState } from 'react';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Banner, CopyButton, Tabs } from '../ui/common';
import { NumberField } from '../ui/Field';
import { useAppState, useStore } from '../../state/store';
import {
  aiSummaryFilename,
  aiSummaryMime,
  buildAiSummary,
  type AiSummaryFormat,
  type AiSummaryInput,
} from '../../exporters/aiSummary';
import { downloadFile } from '../../exporters';
import type { UseGeneration } from '../../hooks/useGeneration';
import { formatBytes } from '../../utils/text';

const FORMATS: Array<{ id: AiSummaryFormat; label: string }> = [
  { id: 'markdown', label: 'Markdown' },
  { id: 'txt', label: 'Plain text' },
  { id: 'json', label: 'JSON' },
];

/**
 * Export for AI summary — a briefing pack for handing the story to a different
 * AI. Unlike the ordinary chat export this is condensed and structured: the
 * whole point is that another model can read it once and be up to speed.
 */
export function AiSummarySheet({
  open,
  onClose,
  gen,
}: {
  open: boolean;
  onClose: () => void;
  gen: UseGeneration;
}) {
  const state = useAppState();
  const { timeline, activeChat, activeBranch } = useStore();
  const [format, setFormat] = useState<AiSummaryFormat>('markdown');
  const [recentCount, setRecentCount] = useState(20);

  const input: AiSummaryInput = useMemo(
    () => ({
      story: gen.story,
      chat: activeChat,
      characters: gen.characters,
      persona: gen.persona,
      summary: gen.summary,
      memories: state.memories.filter(
        (m) => !m.sourceStoryId || m.sourceStoryId === gen.story?.id,
      ),
      lorebooks: state.lorebooks,
      loreEntries: state.loreEntries,
      timeline,
      branchName: activeBranch?.name ?? 'Main',
      recentCount,
    }),
    [
      gen.story,
      gen.characters,
      gen.persona,
      gen.summary,
      activeChat,
      activeBranch,
      state.memories,
      state.lorebooks,
      state.loreEntries,
      timeline,
      recentCount,
    ],
  );

  const output = useMemo(() => buildAiSummary(input, format), [input, format]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Export for AI summary"
      large
      footer={
        <>
          <CopyButton text={output} label="Copy" className="btn" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              downloadFile(aiSummaryFilename(input, format), output, aiSummaryMime(format))
            }
          >
            <Icon name="download" />
            Download
          </button>
        </>
      }
    >
      <Banner kind="info" title="What this is for">
        A condensed briefing you can paste into another AI so it understands the whole story
        immediately — characters, history, relationships, pinned memories, flagged messages and the
        relevant lore, plus only the recent dialogue verbatim. This is not a full transcript; use
        Export chat for that.
      </Banner>

      <Tabs tabs={FORMATS} active={format} onChange={setFormat} label="Export format" />

      <NumberField
        label="Recent messages to include verbatim"
        value={recentCount}
        onChange={(value) => setRecentCount(Math.max(1, Math.round(value)))}
        min={1}
        max={200}
        hint="Everything older is represented by the story summary."
      />

      <div className="row row-between" style={{ marginBottom: 8 }}>
        <span className="small muted">
          {output.length.toLocaleString()} characters · {formatBytes(new Blob([output]).size)}
        </span>
        {!gen.summary?.rollingSummary && (
          <span className="chip chip-warn">No story summary yet</span>
        )}
      </div>

      <pre className="ctx-part-body mono" style={{ maxHeight: '42dvh', borderRadius: 8 }}>
        {output}
      </pre>
    </Sheet>
  );
}
