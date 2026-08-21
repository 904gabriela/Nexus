import { useState } from 'react';
import type { Provider } from '../types';
import { PROVIDER_PRESETS, newProvider } from '../types/factories';
import { useActions, useAppState } from '../state/store';
import { Icon } from '../components/ui/Icon';
import { Banner, EmptyState, Tabs } from '../components/ui/common';
import {
  NumberField,
  SelectField,
  SliderField,
  TextArea,
  TextField,
  Toggle,
} from '../components/ui/Field';
import { Sheet } from '../components/ui/Sheet';
import { useConfirm, deleteConfirm } from '../components/ui/Confirm';
import { fetchModels, maskKey, testConnection, type TestResult } from '../ai/client';
import { LorebookTester } from './Lorebooks';
import { dbCount, STORES } from '../storage/db';
import { formatBytes } from '../utils/text';

export function SettingsPage() {
  const [tab, setTab] = useState<'providers' | 'context' | 'appearance' | 'tools' | 'data'>(
    'providers',
  );
  return (
    <>
      <div className="page-header">
        <h1>
          Settings
          <span className="subtitle">Providers, context and app behaviour</span>
        </h1>
      </div>
      <div className="page">
        <Tabs
          tabs={[
            { id: 'providers', label: 'AI Providers' },
            { id: 'context', label: 'Context' },
            { id: 'appearance', label: 'Appearance' },
            { id: 'tools', label: 'Tools' },
            { id: 'data', label: 'Data' },
          ]}
          active={tab}
          onChange={setTab}
          label="Settings sections"
        />
        {tab === 'providers' && <ProvidersSection />}
        {tab === 'context' && <ContextSection />}
        {tab === 'appearance' && <AppearanceSection />}
        {tab === 'tools' && <LorebookTester />}
        {tab === 'data' && <DataSection />}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- providers */

function ProvidersSection() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<Provider | null>(null);

  return (
    <>
      <Banner kind="warn" title="About API keys in a browser app">
        Nexus Tavern runs entirely on your device and talks to providers directly, so your key is
        stored in this browser's local database and sent to the provider you configure. Anyone with
        access to this device or browser profile can use it. Use a scoped key with a spending limit,
        and never share your screen while a key is revealed. Keys are never included in backups or
        exports.
      </Banner>

      {!state.providers.length ? (
        <EmptyState
          icon="settings"
          title="No AI providers configured"
          message="Add a provider to generate replies. OpenRouter, OpenAI, any OpenAI-compatible gateway, or a local model on your network."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setEditing(newProvider())}
            >
              <Icon name="plus" />
              Add provider
            </button>
          }
        />
      ) : (
        <>
          <SelectField
            label="Active provider"
            value={state.settings.activeProviderId ?? ''}
            onChange={(value) => actions.saveSettings({ activeProviderId: value || null })}
            options={[
              { value: '', label: 'None — generation disabled' },
              ...state.providers.map((p) => ({
                value: p.id,
                label: `${p.name}${p.model ? ` · ${p.model}` : ' · no model selected'}`,
              })),
            ]}
          />

          <div className="list">
            {state.providers.map((provider) => (
              <div className="card" key={provider.id}>
                <div className="row row-between row-wrap">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      <strong className="truncate">{provider.name}</strong>
                      {state.settings.activeProviderId === provider.id && (
                        <span className="chip chip-accent">Active</span>
                      )}
                      <span className="chip">{PROVIDER_PRESETS[provider.kind].label}</span>
                    </div>
                    <div className="small muted truncate">{provider.baseUrl}</div>
                    <div className="small muted">
                      {provider.model || 'No model selected'}
                      {provider.apiKey ? ` · key ${maskKey(provider.apiKey)}` : ' · no key'}
                      {provider.visionSupport ? ' · vision' : ''}
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(provider)}>
                    <Icon name="edit" />
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-block"
            style={{ marginTop: 12 }}
            onClick={() => setEditing(newProvider())}
          >
            <Icon name="plus" />
            Add another provider
          </button>
        </>
      )}

      {editing && (
        <ProviderEditor
          provider={editing}
          onClose={() => setEditing(null)}
          onSave={async (provider) => {
            await actions.saveProvider(provider);
            setEditing(null);
            actions.toast({ kind: 'success', title: `Saved "${provider.name}"` });
          }}
          onDelete={
            state.providers.some((p) => p.id === editing.id)
              ? async () => {
                  const ok = await confirm(deleteConfirm('provider', editing.name));
                  if (!ok) return;
                  await actions.deleteProvider(editing.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function ProviderEditor({
  provider,
  onClose,
  onSave,
  onDelete,
}: {
  provider: Provider;
  onClose: () => void;
  onSave: (provider: Provider) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<Provider>(provider);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const patch = (changes: Partial<Provider>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setResult(null);
  };

  const changeKind = (kind: Provider['kind']) => {
    const preset = PROVIDER_PRESETS[kind];
    patch({
      kind,
      baseUrl: preset.baseUrl || draft.baseUrl,
      name: draft.name === 'New Provider' ? preset.label : draft.name,
    });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await testConnection(draft));
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async () => {
    setFetching(true);
    setResult(null);
    try {
      const { models } = await fetchModels(draft);
      patch({ models, model: draft.model || models[0] });
      setResult({ ok: true, message: `Loaded ${models.length} models.` });
    } catch (err) {
      setResult({
        ok: false,
        message: (err as Error).message,
        detail: (err as { detail?: string }).detail,
      });
    } finally {
      setFetching(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={provider.name === 'New Provider' ? 'Add provider' : 'Edit provider'}
      large
      footer={
        <>
          {onDelete && (
            <button type="button" className="btn btn-danger" onClick={onDelete}>
              <Icon name="trash" />
              Delete
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(draft)}>
            <Icon name="save" />
            Save
          </button>
        </>
      }
    >
      <SelectField
        label="Provider type"
        value={draft.kind}
        onChange={changeKind}
        options={(Object.keys(PROVIDER_PRESETS) as Provider['kind'][]).map((kind) => ({
          value: kind,
          label: PROVIDER_PRESETS[kind].label,
        }))}
        hint={PROVIDER_PRESETS[draft.kind].hint}
      />

      <TextField label="Name" value={draft.name} onChange={(name) => patch({ name })} required />

      <TextField
        label="Base URL"
        value={draft.baseUrl}
        onChange={(baseUrl) => patch({ baseUrl })}
        required
        type="url"
        inputMode="url"
        placeholder="https://openrouter.ai/api/v1"
        hint={
          draft.kind === 'local'
            ? 'Any LAN address works, e.g. http://192.168.1.42:1234/v1 or http://192.168.1.42:11434/v1. Do not assume localhost — use the address of the machine running the model. "/v1" is added automatically if you leave it off.'
            : 'The OpenAI-compatible root. "/chat/completions" is appended automatically.'
        }
      />

      <div className="field">
        <label className="field-label" htmlFor="api-key">
          API key
        </label>
        <div className="row" style={{ gap: 6 }}>
          <input
            id="api-key"
            className="input"
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={draft.kind === 'local' ? 'Usually not needed for local models' : 'sk-…'}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            aria-pressed={showKey}
          >
            <Icon name={showKey ? 'eyeOff' : 'eye'} />
          </button>
        </div>
        <div className="field-hint">
          {draft.apiKey && !showKey ? `Stored as ${maskKey(draft.apiKey)}. ` : ''}
          Keys stay on this device and are excluded from every backup and export.
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button type="button" className="btn btn-sm" onClick={test} disabled={testing || !draft.baseUrl}>
          {testing ? <span className="spinner" /> : <Icon name="link" />}
          Test connection
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={loadModels}
          disabled={fetching || !draft.baseUrl}
        >
          {fetching ? <span className="spinner" /> : <Icon name="refresh" />}
          Fetch models
        </button>
      </div>

      {result && (
        <Banner
          kind={result.ok ? 'success' : 'error'}
          title={result.ok ? 'Connected' : 'Connection failed'}
        >
          {result.message}
          {result.detail && (
            <>
              {' '}
              <span className="mono small">{result.detail}</span>
            </>
          )}
        </Banner>
      )}

      {draft.models.length ? (
        <SelectField
          label="Model"
          value={draft.model}
          onChange={(model) => patch({ model })}
          options={draft.models.map((model) => ({ value: model, label: model }))}
        />
      ) : (
        <TextField
          label="Model"
          value={draft.model}
          onChange={(model) => patch({ model })}
          placeholder="anthropic/claude-sonnet-4.5"
          hint="Fetch models above to pick from a list, or type the id directly."
        />
      )}

      <Toggle
        label="Streaming"
        description="Show the reply as it is written. Turn off if your endpoint does not support SSE."
        checked={draft.streaming}
        onChange={(streaming) => patch({ streaming })}
      />
      <Toggle
        label="Vision support"
        description="Send attached images to the model. Only enable this for models that accept images, or requests will fail."
        checked={draft.visionSupport}
        onChange={(visionSupport) => patch({ visionSupport })}
      />

      <hr className="divider" />
      <h3 className="section-title">Default generation parameters</h3>

      <SliderField
        label="Temperature"
        value={draft.temperature}
        onChange={(temperature) => patch({ temperature })}
        min={0}
        max={2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        hint="Higher is more creative and less predictable."
      />
      <NumberField
        label="Max response tokens"
        value={draft.maxTokens}
        onChange={(maxTokens) => patch({ maxTokens: Math.max(16, Math.round(maxTokens)) })}
        min={16}
        max={32000}
      />
      <SliderField
        label="Top P"
        value={draft.topP}
        onChange={(topP) => patch({ topP })}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
      />

      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
      >
        <Icon name={advanced ? 'chevronUp' : 'chevronDown'} />
        Advanced
      </button>

      {advanced && (
        <>
          <SliderField
            label="Frequency penalty"
            value={draft.frequencyPenalty}
            onChange={(frequencyPenalty) => patch({ frequencyPenalty })}
            min={-2}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <SliderField
            label="Presence penalty"
            value={draft.presencePenalty}
            onChange={(presencePenalty) => patch({ presencePenalty })}
            min={-2}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <TextArea
            label="Extra headers (JSON)"
            value={JSON.stringify(draft.extraHeaders ?? {}, null, 2)}
            onChange={(value) => {
              try {
                const parsed = JSON.parse(value || '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  patch({ extraHeaders: parsed as Record<string, string> });
                }
              } catch {
                /* keep the previous value until the JSON is valid again */
              }
            }}
            hint='Sent with every request, e.g. {"X-Title": "My App"}. Invalid JSON is ignored.'
          />
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------- context */

function ContextSection() {
  const state = useAppState();
  const actions = useActions();
  const s = state.settings;

  return (
    <>
      <TextArea
        label="Global system prompt"
        value={s.globalSystemPrompt}
        onChange={(globalSystemPrompt) => actions.saveSettings({ globalSystemPrompt })}
        large
        hint="Applied to every chat, before character and story instructions."
      />
      <TextArea
        label="Global instructions"
        value={s.globalInstructions}
        onChange={(globalInstructions) => actions.saveSettings({ globalInstructions })}
        hint="Extra rules appended after the system prompt — formatting preferences, content boundaries, prose style."
      />

      <hr className="divider" />
      <h3 className="section-title">Context budget</h3>

      <NumberField
        label="Context size (tokens)"
        value={s.contextBudget}
        onChange={(contextBudget) => actions.saveSettings({ contextBudget: Math.max(512, Math.round(contextBudget)) })}
        min={512}
        max={1000000}
        step={512}
        hint="Match this to your model's context window. Stories and chats can override it."
      />
      <NumberField
        label="Reserve for the reply (tokens)"
        value={s.reserveForResponse}
        onChange={(reserveForResponse) =>
          actions.saveSettings({ reserveForResponse: Math.max(0, Math.round(reserveForResponse)) })
        }
        min={0}
        max={32000}
        step={128}
        hint="Held back from the budget so the model has room to answer."
      />
      <NumberField
        label="History limit (messages)"
        value={s.historyLimit}
        onChange={(historyLimit) => actions.saveSettings({ historyLimit: Math.max(2, Math.round(historyLimit)) })}
        min={2}
        max={2000}
        hint="Upper bound on how many recent messages are considered, before the token budget trims further."
      />

      <hr className="divider" />
      <h3 className="section-title">Lore &amp; memory</h3>

      <NumberField
        label="Lore scan depth (messages)"
        value={s.loreScanDepth}
        onChange={(loreScanDepth) => actions.saveSettings({ loreScanDepth: Math.max(1, Math.round(loreScanDepth)) })}
        min={1}
        max={100}
        hint="How many recent messages are searched for lorebook keywords."
      />
      <NumberField
        label="Maximum lore entries per reply"
        value={s.maxLoreEntries}
        onChange={(maxLoreEntries) => actions.saveSettings({ maxLoreEntries: Math.max(0, Math.round(maxLoreEntries)) })}
        min={0}
        max={200}
        hint="When more entries match, the highest-priority ones win."
      />
      <NumberField
        label="Maximum memories per reply"
        value={s.maxMemories}
        onChange={(maxMemories) => actions.saveSettings({ maxMemories: Math.max(0, Math.round(maxMemories)) })}
        min={0}
        max={200}
        hint="Pinned and critical memories are chosen first."
      />
    </>
  );
}

/* ---------------------------------------------------------- appearance */

function AppearanceSection() {
  const state = useAppState();
  const actions = useActions();
  const s = state.settings;

  return (
    <>
      <SelectField
        label="Theme"
        value={s.theme}
        onChange={(theme) => actions.saveSettings({ theme })}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]}
      />
      <SliderField
        label="Text size"
        value={s.fontScale}
        onChange={(fontScale) => actions.saveSettings({ fontScale })}
        min={0.85}
        max={1.4}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
      />
      <Toggle
        label="Enter sends the message"
        description="On: Enter sends, Shift+Enter makes a new line. Off (better on phones): the send button sends, Ctrl/Cmd+Enter also works."
        checked={s.sendOnEnter}
        onChange={(sendOnEnter) => actions.saveSettings({ sendOnEnter })}
      />
      <Toggle
        label="Show the token estimate in chat"
        checked={s.showTokenCounts}
        onChange={(showTokenCounts) => actions.saveSettings({ showTokenCounts })}
      />
    </>
  );
}

/* ---------------------------------------------------------------- data */

function DataSection() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [estimate, setEstimate] = useState<string | null>(null);

  const inspect = async () => {
    const entries = await Promise.all(
      Object.values(STORES).map(async (store) => [store, await dbCount(store)] as const),
    );
    setCounts(Object.fromEntries(entries));
    if (navigator.storage?.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        if (usage != null) {
          setEstimate(
            `${formatBytes(usage)} used${quota ? ` of about ${formatBytes(quota)} available` : ''}`,
          );
        }
      } catch {
        setEstimate(null);
      }
    }
  };

  return (
    <>
      <Banner kind="info" title="Where your data lives">
        Everything is stored in this browser's IndexedDB database on this device. Nothing is uploaded
        anywhere except the messages you send to your configured AI provider. Clearing site data in
        your browser deletes it all — keep backups.
      </Banner>

      <button type="button" className="btn btn-block" onClick={inspect}>
        <Icon name="search" />
        Inspect local database
      </button>

      {counts && (
        <div className="card" style={{ marginTop: 12 }}>
          {estimate && (
            <div className="small muted" style={{ marginBottom: 8 }}>
              Storage: {estimate}
            </div>
          )}
          <div className="stack">
            {Object.entries(counts).map(([store, count]) => (
              <div className="row row-between" key={store}>
                <span className="small mono">{store}</span>
                <span className="chip">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <hr className="divider" />

      <button
        type="button"
        className="btn btn-danger btn-block"
        onClick={async () => {
          const ok = await confirm({
            title: 'Erase all local data?',
            message: (
              <Banner kind="error" title="Everything will be deleted">
                All {state.characters.length} character(s), {state.personas.length} persona(s),{' '}
                {state.stories.length} story/ies, {state.chats.length} chat(s),{' '}
                {state.lorebooks.length} lorebook(s), {state.memories.length} memory/ies and{' '}
                {state.media.length} image(s) on this device. Download a backup first if you might
                want any of it back.
              </Banner>
            ),
            confirmLabel: 'Erase everything',
            destructive: true,
            typeToConfirm: 'ERASE',
          });
          if (!ok) return;
          const { ALL_DATA_STORES, dbClear } = await import('../storage/db');
          for (const store of ALL_DATA_STORES) await dbClear(store);
          await actions.reload();
          actions.toast({ kind: 'success', title: 'All local data erased' });
        }}
      >
        <Icon name="trash" />
        Erase all local data
      </button>
    </>
  );
}
