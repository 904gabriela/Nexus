import { useMemo, useState } from 'react';
import type { CompileResult } from '../../context/compiler';
import { contextToText } from '../../context/compiler';
import { formatTokens } from '../../context/tokens';
import { Sheet } from '../ui/Sheet';
import { Icon } from '../ui/Icon';
import { Banner, CopyButton, Tabs } from '../ui/common';
import { truncate } from '../../utils/text';
import { formatRequest, getLastRequest } from '../../ai/requestLog';

const KIND_LABEL: Record<string, string> = {
  system: 'System',
  global: 'Global',
  scene: 'Scene & presence',
  character: 'Character',
  persona: 'Persona',
  story: 'Story',
  scenario: 'Scenario',
  lore: 'Lore',
  memory: 'Memory',
  'author-note': "Author's note",
  direction: 'Direction',
  history: 'Message',
  instruction: 'Instruction',
};

/**
 * Shows exactly what the compiler produced — the same structure that is sent to
 * the model, part by part, with the reason each part was included or dropped.
 */
export function ContextInspector({
  compiled,
  open,
  onClose,
}: {
  compiled: CompileResult;
  open: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'included' | 'excluded' | 'lore' | 'raw' | 'request'>(
    'included',
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const map = new Map<string, typeof compiled.parts>();
    for (const part of compiled.parts) {
      const list = map.get(part.kind);
      if (list) list.push(part);
      else map.set(part.kind, [part]);
    }
    return map;
  }, [compiled.parts]);

  const usedPct = Math.min(100, Math.round((compiled.totalTokens / Math.max(1, compiled.budget)) * 100));
  const meterClass = compiled.overBudget ? 'over' : usedPct > 80 ? 'warn' : '';

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const raw = useMemo(() => contextToText(compiled), [compiled]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Context Inspector"
      large
      footer={
        <>
          <CopyButton text={raw} label="Copy full context" className="btn btn-primary" />
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close context inspector"
          >
            Close
          </button>
        </>
      }
    >
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row row-between">
          <strong>
            {formatTokens(compiled.totalTokens)} / {formatTokens(compiled.budget)} tokens
          </strong>
          <span className={`chip ${compiled.overBudget ? 'chip-danger' : usedPct > 80 ? 'chip-warn' : 'chip-success'}`}>
            {usedPct}% of budget
          </span>
        </div>
        <div className="meter">
          <div className={`meter-fill ${meterClass}`} style={{ width: `${usedPct}%` }} />
        </div>
        <div className="small muted">
          Token counts are estimates (no tokenizer is bundled), typically within ~12% of the real
          count. The budget is your context size minus the reserve for the reply.
        </div>
      </div>

      {compiled.overBudget && (
        <Banner kind="warn" title="Context exceeds the budget">
          Lower-priority parts and older messages were trimmed. Raise the context size in Settings,
          pin fewer memories, or trim lorebook entries.
        </Banner>
      )}

      <Tabs
        tabs={[
          { id: 'included', label: 'Included', badge: compiled.parts.length },
          { id: 'excluded', label: 'Excluded', badge: compiled.excluded.length },
          { id: 'lore', label: 'Lore & memory' },
          { id: 'raw', label: 'Raw' },
          { id: 'request', label: 'Provider request' },
        ]}
        active={tab}
        onChange={setTab}
        label="Context views"
      />

      {tab === 'included' && (
        <>
          {[...grouped.entries()].map(([kind, parts]) => (
            <section key={kind} style={{ marginBottom: 14 }}>
              <h3 className="section-title">
                {KIND_LABEL[kind] ?? kind}
                <span className="chip">
                  {formatTokens(parts.reduce((sum, p) => sum + p.tokens, 0))} tok
                </span>
              </h3>
              {parts.map((part) => (
                <div className="ctx-part" key={part.id}>
                  <button
                    type="button"
                    className="ctx-part-head"
                    onClick={() => toggle(part.id)}
                    aria-expanded={expanded.has(part.id)}
                  >
                    <Icon name={expanded.has(part.id) ? 'chevronDown' : 'chevronRight'} width={15} height={15} />
                    <span className="ctx-part-label">
                      {part.label}
                      <span className="ctx-part-reason">{part.reason}</span>
                    </span>
                    <span className="chip">{formatTokens(part.tokens)}</span>
                  </button>
                  {expanded.has(part.id) && <div className="ctx-part-body">{part.content}</div>}
                </div>
              ))}
            </section>
          ))}
        </>
      )}

      {tab === 'excluded' && (
        <>
          {!compiled.excluded.length ? (
            <p className="small muted">Nothing was excluded — everything fits inside the budget.</p>
          ) : (
            compiled.excluded.map((part) => (
              <div className="ctx-part excluded" key={`ex-${part.id}`}>
                <button
                  type="button"
                  className="ctx-part-head"
                  onClick={() => toggle(`ex-${part.id}`)}
                  aria-expanded={expanded.has(`ex-${part.id}`)}
                >
                  <Icon name={expanded.has(`ex-${part.id}`) ? 'chevronDown' : 'chevronRight'} width={15} height={15} />
                  <span className="ctx-part-label">
                    {part.label}
                    <span className="ctx-part-reason">{part.reason}</span>
                  </span>
                  <span className="chip">{formatTokens(part.tokens)}</span>
                </button>
                {expanded.has(`ex-${part.id}`) && <div className="ctx-part-body">{part.content}</div>}
              </div>
            ))
          )}
        </>
      )}

      {tab === 'lore' && (
        <>
          <h3 className="section-title">
            Triggered lore entries
            <span className="chip chip-success">{compiled.loreHits.length}</span>
          </h3>
          {!compiled.loreHits.length ? (
            <p className="small muted">No lore entries triggered for this context.</p>
          ) : (
            compiled.loreHits.map((hit) => (
              <div className="card" key={hit.entry.id} style={{ marginBottom: 8 }}>
                <div className="row row-between row-wrap">
                  <strong>{hit.entry.name || 'Untitled entry'}</strong>
                  <span className="chip">{hit.lorebookName}</span>
                </div>
                <div className="small" style={{ color: 'var(--success)', marginTop: 3 }}>
                  Triggered because: {hit.reason}
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>
                  {truncate(hit.entry.content, 160)}
                </div>
              </div>
            ))
          )}

          <h3 className="section-title" style={{ marginTop: 18 }}>
            Lore entries not included
            <span className="chip">{compiled.loreMisses.length}</span>
          </h3>
          {!compiled.loreMisses.length ? (
            <p className="small muted">Every candidate entry was included.</p>
          ) : (
            compiled.loreMisses.slice(0, 60).map((miss) => (
              <div className="card" key={`miss-${miss.entry.id}`} style={{ marginBottom: 6, opacity: 0.85 }}>
                <div className="row row-between row-wrap">
                  <strong className="truncate small">{miss.entry.name || 'Untitled entry'}</strong>
                  <span className="chip">{miss.lorebookName}</span>
                </div>
                <div className="small muted">Excluded because: {miss.reason}</div>
              </div>
            ))
          )}

          <h3 className="section-title" style={{ marginTop: 18 }}>
            Memories
            <span className="chip chip-success">{compiled.memoryHits.length}</span>
          </h3>
          {!compiled.memoryHits.length ? (
            <p className="small muted">No memories are being injected.</p>
          ) : (
            compiled.memoryHits.map((hit) => (
              <div className="card" key={hit.memory.id} style={{ marginBottom: 6 }}>
                <div className="row row-between row-wrap">
                  <strong className="truncate">{hit.memory.title || 'Untitled memory'}</strong>
                  <span className="chip">{hit.memory.category}</span>
                </div>
                <div className="small" style={{ color: 'var(--accent-text)' }}>
                  Included because: {hit.reason}
                </div>
              </div>
            ))
          )}
        </>
      )}

      {tab === 'request' && <RequestView />}

      {tab === 'raw' && (
        <>
          <p className="small muted">
            This is the payload as the model receives it, flattened to text.
          </p>
          <pre className="ctx-part-body mono" style={{ maxHeight: 460, borderRadius: 8 }}>
            {raw}
          </pre>
        </>
      )}
    </Sheet>
  );
}


/**
 * The body that actually left the app, as JSON.
 *
 * The Assembled tab shows what the compiler built; this shows what the server
 * received. They are meant to agree, and every roleplay failure worth debugging
 * so far has lived in the gap between them — a context size the model could not
 * honour, a prompt truncated at the head, options that never made the trip.
 */
function RequestView() {
  const request = getLastRequest();
  const json = formatRequest(request);

  if (!request) {
    return (
      <Banner kind="info" title="No request yet">
        Send a message and this will show the exact JSON body posted to the provider,
        including the context window it was told to use.
      </Banner>
    );
  }

  const options = (request.body as any)?.options ?? {};
  const messages = (request.body as any)?.messages ?? [];

  return (
    <>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="small muted">{request.dialect === 'ollama' ? 'Ollama native API' : 'OpenAI-compatible API'}</div>
        <div className="small" style={{ wordBreak: 'break-all' }}>{request.url}</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <span className="chip">{messages.length} messages</span>
          {typeof options.num_ctx === 'number' && (
            <span className="chip chip-success">num_ctx {options.num_ctx.toLocaleString()}</span>
          )}
          {typeof options.num_predict === 'number' && (
            <span className="chip">num_predict {options.num_predict}</span>
          )}
          {request.modelLimit && (
            <span className="chip">model holds {request.modelLimit.toLocaleString()}</span>
          )}
        </div>
        {!!request.breakdown?.length && (
          <table className="ctx-breakdown" style={{ width: '100%', marginTop: 10 }}>
            <tbody>
              {request.breakdown.map((row) => (
                <tr key={row.label}>
                  <td className="small muted">{KIND_LABEL[row.label] ?? row.label}</td>
                  <td className="small" style={{ textAlign: 'right' }}>
                    {formatTokens(row.tokens)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="small"><strong>Total input</strong></td>
                <td className="small" style={{ textAlign: 'right' }}>
                  <strong>{formatTokens(request.promptTokens ?? 0)}</strong>
                </td>
              </tr>
              <tr>
                <td className="small muted">Output budget (num_predict)</td>
                <td className="small" style={{ textAlign: 'right' }}>
                  {formatTokens(request.outputBudget ?? 0)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
        {request.clamped && (
          <div className="small muted" style={{ marginTop: 8 }}>
            The configured context size was larger than this model can hold, so it was
            reduced. Without that, the server would have truncated the prompt itself —
            starting from the beginning, where the scene and persona live.
          </div>
        )}
      </div>
      <CopyButton text={json} label="Copy provider request" className="btn" />
      <pre className="ctx-raw" style={{ marginTop: 10 }}>{json}</pre>
    </>
  );
}
