import { useEffect, useState } from 'react';
import type { ImageProvider, ModelCapabilities, Provider } from '../types';
import { ASPECT_RATIOS, AUTO_MEMORY_TRIGGERS } from '../types';
import {
  IMAGE_PROVIDER_PRESETS,
  PROVIDER_PRESETS,
  inferCapabilities,
  newImageProvider,
  newProvider,
} from '../types/factories';
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
import {
  ProviderError,
  corsRemedy,
  fetchModels,
  maskKey,
  testConnection,
  type TestResult,
} from '../ai/client';
import {
  fetchImageModels,
  maskKey as maskImageKey,
  testImageProvider,
  type ImageTestResult,
} from '../ai/imageClient';
import { LorebookTester } from './Lorebooks';
import { dbCount, STORES } from '../storage/db';
import {
  readStorageStatus,
  requestPersistence,
  type StorageStatus,
} from '../storage/persistence';
import { formatBytes } from '../utils/text';

export function SettingsPage() {
  const [tab, setTab] = useState<
    'providers' | 'images' | 'memory' | 'context' | 'appearance' | 'tools' | 'data'
  >('providers');
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
            { id: 'images', label: 'Image Generation' },
            { id: 'memory', label: 'Memory' },
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
        {tab === 'images' && <ImageProvidersSection />}
        {tab === 'memory' && <MemorySection />}
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
        Storyline runs entirely on your device and talks to providers directly, so your key is
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

/**
 * What the connection test established, step by step.
 *
 * "Reachable" and "ready" are different states, and so are "nothing is
 * listening" and "the browser would not let this page read the reply". Showing
 * the sequence means a partial success reads as progress rather than as a
 * failure, and names the one remaining thing to do.
 */
function Diagnostics({ result }: { result: TestResult }) {
  const title = !result.ok
    ? result.code === 'CORS_BLOCKED'
      ? 'Reachable, but your browser blocked it'
      : result.code === 'NETWORK_UNREACHABLE'
        ? 'Nothing answered at that address'
        : result.code === 'LOOPBACK_FROM_OTHER_DEVICE'
          ? 'That address points at this device'
          : result.code === 'MIXED_CONTENT'
            ? 'Blocked: HTTPS page, HTTP endpoint'
            : result.code === 'TIMEOUT'
              ? 'Timed out'
              : 'Connection failed'
    : result.code === 'MODEL_NOT_SELECTED'
      ? 'Server reachable — choose a model'
      : result.code === 'MODEL_NOT_FOUND'
        ? 'Server reachable — that model is not on it'
        : 'Provider ready';

  return (
    <Banner
      kind={!result.ok ? 'error' : result.code ? 'warn' : 'success'}
      title={title}
    >
      {!!result.steps?.length && (
        <ul className="diagnostic-steps">
          {result.steps.map((step) => (
            <li key={step.label} className={`diagnostic-step is-${step.state}`}>
              <span aria-hidden="true">
                {step.state === 'ok' ? '✓' : step.state === 'warn' ? '!' : '✗'}
              </span>
              <span>{step.label}</span>
            </li>
          ))}
        </ul>
      )}
      {result.message}
      {result.remedy && (
        <p style={{ marginBottom: 0 }}>
          <strong>How to fix it: </strong>
          {result.remedy}
        </p>
      )}
      {result.detail && (
        <p className="mono small" style={{ marginBottom: 0, opacity: 0.8 }}>
          {result.detail}
        </p>
      )}
    </Banner>
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
      const outcome = await testConnection(draft);
      // A test that reached the server has already listed the models; keeping
      // them saves a second round trip and lets the picker fill itself.
      if (outcome.discovered) {
        patch({
          models: outcome.discovered.models,
          modelInfo: outcome.discovered.info,
          ...(draft.model.trim() || outcome.discovered.models.length !== 1
            ? {}
            : { model: outcome.discovered.models[0] }),
        });
      }
      setResult(outcome);
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async () => {
    setFetching(true);
    setResult(null);
    try {
      const { models, info } = await fetchModels(draft);
      // One model means there is nothing to choose: select it rather than
      // making the user retype what the server just reported.
      const model = draft.model.trim() && models.includes(draft.model.trim())
        ? draft.model
        : models.length === 1
          ? models[0]
          : draft.model || models[0];
      patch({ models, modelInfo: info, model });
      setResult({
        ok: true,
        message:
          models.length === 1
            ? `Found one model and selected it: ${models[0]}.`
            : `Loaded ${models.length} models.`,
        models: models.length,
      });
    } catch (err) {
      const e = err instanceof ProviderError ? err : null;
      setResult({
        ok: false,
        message: (err as Error).message,
        detail: e?.detail ?? (err as { detail?: string }).detail,
        code: e?.code,
        remedy: e?.code === 'CORS_BLOCKED' ? corsRemedy(draft.baseUrl) : undefined,
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
          draft.kind === 'ollama'
            ? 'Just the address of the machine running Ollama, e.g. http://192.168.1.49:11434 — no path needed. Use that machine\'s address on your network, never localhost, unless Ollama runs on this same device.'
            : draft.kind === 'local'
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

      {result && <Diagnostics result={result} />}

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
      <CapabilityPanel draft={draft} onChange={patch} />

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
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [asking, setAsking] = useState(false);

  // Read the durability state on mount so the section is truthful before the
  // user presses anything.
  useEffect(() => {
    void readStorageStatus().then(setStorage);
  }, []);

  const askForPersistence = async () => {
    setAsking(true);
    try {
      const next = await requestPersistence(true);
      setStorage(next);
      actions.toast(
        next.state === 'persistent'
          ? { kind: 'success', title: 'Your browser agreed to keep this data' }
          : {
              kind: 'warn',
              title: 'The browser did not grant persistent storage',
              detail:
                'This is common and not an error. Keep backups — that is the only guarantee.',
            },
      );
    } finally {
      setAsking(false);
    }
  };

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

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row row-between row-wrap">
          <strong>Storage durability</strong>
          <span
            className={`chip ${
              storage?.state === 'persistent'
                ? 'chip-success'
                : storage?.state === 'best-effort'
                  ? 'chip-warn'
                  : 'chip'
            }`}
          >
            {storage?.state === 'persistent'
              ? 'Persistent'
              : storage?.state === 'best-effort'
                ? 'Best effort'
                : 'Unknown'}
          </span>
        </div>
        <p className="small muted" style={{ marginTop: 6 }}>
          {storage?.state === 'persistent'
            ? 'This browser has agreed not to evict your data automatically. It can still be lost ' +
              'if you clear site data, uninstall the browser, or lose the device — so keep backups.'
            : storage?.state === 'best-effort'
              ? 'Your data is stored "best effort": a browser may clear it when storage runs low, ' +
                'and some browsers discard unused site data after a week or so. Ask for persistent ' +
                'storage below, and keep backups either way.'
              : 'This browser does not report a storage-durability setting. Keep backups.'}
        </p>
        {storage?.usage != null && (
          <p className="small muted">
            Using {formatBytes(storage.usage)}
            {storage.quota ? ` of about ${formatBytes(storage.quota)} available` : ''}.
          </p>
        )}
        {storage?.state === 'best-effort' && (
          <button type="button" className="btn btn-block" onClick={askForPersistence} disabled={asking}>
            {asking ? <span className="spinner" /> : <Icon name="save" />}
            Ask the browser to keep this data
          </button>
        )}
      </div>

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

/* --------------------------------------------------- model capabilities */

/**
 * Model capabilities drive which controls are available elsewhere in the app,
 * so they are shown plainly — including whether the provider actually reported
 * them or we had to guess from the model name.
 */
function CapabilityPanel({
  draft,
  onChange,
}: {
  draft: Provider;
  onChange: (patch: Partial<Provider>) => void;
}) {
  const reported = draft.modelInfo?.[draft.model];
  const base = reported?.capabilities ?? inferCapabilities(draft.model || '');
  const effective: ModelCapabilities = {
    text: draft.capabilityOverrides?.text ?? base.text,
    vision: draft.capabilityOverrides?.vision ?? (draft.visionSupport || base.vision),
    streaming: draft.capabilityOverrides?.streaming ?? (draft.streaming && base.streaming),
    imageGeneration: draft.capabilityOverrides?.imageGeneration ?? base.imageGeneration,
  };

  const setOverride = (key: keyof ModelCapabilities, value: boolean) => {
    const next = { ...(draft.capabilityOverrides ?? {}), [key]: value };
    // Keep the legacy flag in step so nothing reads a stale value.
    onChange(
      key === 'vision'
        ? { capabilityOverrides: next, visionSupport: value }
        : { capabilityOverrides: next },
    );
  };

  const rows: Array<{ key: keyof ModelCapabilities; label: string; hint: string }> = [
    { key: 'text', label: 'Text generation', hint: 'Can produce chat replies.' },
    {
      key: 'vision',
      label: 'Vision (image understanding)',
      hint: 'Attached images are sent to the model. Turning this on for a model that cannot read images makes requests fail.',
    },
    { key: 'streaming', label: 'Streaming', hint: 'Show the reply as it is written.' },
    {
      key: 'imageGeneration',
      label: 'Image generation',
      hint: 'Informational only — image generation is configured separately under Image Generation.',
    },
  ];

  return (
    <section className="section">
      <h3 className="section-title">
        Model capabilities
        <span className={`chip ${reported?.reported ? 'chip-success' : 'chip-warn'}`}>
          {reported?.reported ? 'Reported by provider' : 'Inferred from model name'}
        </span>
      </h3>
      {!reported?.reported && (
        <Banner kind="info" title="These are a best guess">
          This provider did not describe {draft.model || 'the selected model'}, so capabilities were
          inferred from its name. Correct anything that is wrong — the app gates its controls on
          these values.
        </Banner>
      )}
      <div className="stack">
        {rows.map((row) => (
          <Toggle
            key={row.key}
            label={row.label}
            description={row.hint}
            checked={effective[row.key]}
            onChange={(value) => setOverride(row.key, value)}
          />
        ))}
      </div>
      {Object.keys(draft.capabilityOverrides ?? {}).length > 0 && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => onChange({ capabilityOverrides: {} })}
        >
          <Icon name="refresh" />
          Reset to detected values
        </button>
      )}
    </section>
  );
}

/* ----------------------------------------------------- image generation */

function ImageProvidersSection() {
  const state = useAppState();
  const actions = useActions();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ImageProvider | null>(null);

  return (
    <>
      <Banner kind="info" title="Image generation is configured separately">
        Your text model and your image model are independent — most people pair a chat provider with
        a different image service. Nothing here affects text generation.
      </Banner>

      {!state.imageProviders.length ? (
        <EmptyState
          icon="sparkle"
          title="No image provider configured"
          message="Add one to generate scene art and character portraits from inside a chat."
          action={
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setEditing(newImageProvider())}
            >
              <Icon name="plus" />
              Add image provider
            </button>
          }
        />
      ) : (
        <>
          <SelectField
            label="Active image provider"
            value={state.settings.activeImageProviderId ?? ''}
            onChange={(value) => actions.saveSettings({ activeImageProviderId: value || null })}
            options={[
              { value: '', label: 'None — image generation disabled' },
              ...state.imageProviders.map((p) => ({
                value: p.id,
                label: `${p.name}${p.model ? ` · ${p.model}` : ''}`,
              })),
            ]}
          />

          <div className="list">
            {state.imageProviders.map((provider) => (
              <div className="card" key={provider.id}>
                <div className="row row-between row-wrap">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      <strong className="truncate">{provider.name}</strong>
                      {state.settings.activeImageProviderId === provider.id && (
                        <span className="chip chip-accent">Active</span>
                      )}
                      <span className="chip">{IMAGE_PROVIDER_PRESETS[provider.kind].label}</span>
                    </div>
                    <div className="small muted truncate">{provider.baseUrl}</div>
                    <div className="small muted">
                      {provider.model || 'No model set'}
                      {provider.apiKey ? ` · key ${maskImageKey(provider.apiKey)}` : ' · no key'}
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
            onClick={() => setEditing(newImageProvider())}
          >
            <Icon name="plus" />
            Add another image provider
          </button>
        </>
      )}

      {editing && (
        <ImageProviderEditor
          provider={editing}
          onClose={() => setEditing(null)}
          onSave={async (provider) => {
            await actions.saveImageProvider(provider);
            setEditing(null);
            actions.toast({ kind: 'success', title: `Saved "${provider.name}"` });
          }}
          onDelete={
            state.imageProviders.some((p) => p.id === editing.id)
              ? async () => {
                  const ok = await confirm(deleteConfirm('image provider', editing.name));
                  if (!ok) return;
                  await actions.deleteImageProvider(editing.id);
                  setEditing(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

function ImageProviderEditor({
  provider,
  onClose,
  onSave,
  onDelete,
}: {
  provider: ImageProvider;
  onClose: () => void;
  onSave: (provider: ImageProvider) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<ImageProvider>(provider);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<'test' | 'models' | null>(null);
  const [result, setResult] = useState<ImageTestResult | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const patch = (changes: Partial<ImageProvider>) => {
    setDraft((current) => ({ ...current, ...changes }));
    setResult(null);
  };

  const changeKind = (kind: ImageProvider['kind']) => {
    const preset = IMAGE_PROVIDER_PRESETS[kind];
    patch({
      kind,
      baseUrl: preset.baseUrl || draft.baseUrl,
      model: preset.model || draft.model,
      name: draft.name === 'New Image Provider' ? preset.label : draft.name,
    });
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={provider.name === 'New Image Provider' ? 'Add image provider' : 'Edit image provider'}
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
        options={(Object.keys(IMAGE_PROVIDER_PRESETS) as ImageProvider['kind'][]).map((kind) => ({
          value: kind,
          label: IMAGE_PROVIDER_PRESETS[kind].label,
        }))}
        hint={IMAGE_PROVIDER_PRESETS[draft.kind].hint}
      />

      <TextField label="Name" value={draft.name} onChange={(name) => patch({ name })} required />
      <TextField
        label="Base URL"
        value={draft.baseUrl}
        onChange={(baseUrl) => patch({ baseUrl })}
        required
        type="url"
        inputMode="url"
        hint={
          draft.kind === 'gemini'
            ? 'The Gemini API root. The model path is appended automatically.'
            : 'The API root. "/images/generations" is appended automatically.'
        }
      />

      <div className="field">
        <label className="field-label" htmlFor="image-api-key">
          API key
        </label>
        <div className="row" style={{ gap: 6 }}>
          <input
            id="image-api-key"
            className="input"
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide image API key' : 'Show image API key'}
            aria-pressed={showKey}
          >
            <Icon name={showKey ? 'eyeOff' : 'eye'} />
          </button>
        </div>
        <div className="field-hint">
          Stored on this device only, and excluded from every backup and export.
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== null || !draft.baseUrl}
          onClick={async () => {
            setBusy('test');
            try {
              setResult(await testImageProvider(draft));
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'test' ? <span className="spinner" /> : <Icon name="link" />}
          Test connection
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== null || !draft.baseUrl}
          onClick={async () => {
            setBusy('models');
            try {
              const models = await fetchImageModels(draft);
              patch({ models, model: draft.model || models[0] });
              setResult({ ok: true, message: `Loaded ${models.length} models.` });
            } catch (err) {
              setResult({
                ok: false,
                message: (err as Error).message,
                detail: (err as { detail?: string }).detail,
              });
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'models' ? <span className="spinner" /> : <Icon name="refresh" />}
          Fetch models
        </button>
      </div>

      {result && (
        <Banner kind={result.ok ? 'success' : 'error'} title={result.ok ? 'Connected' : 'Failed'}>
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
          label="Image model"
          value={draft.model}
          onChange={(model) => patch({ model })}
          options={draft.models.map((model) => ({ value: model, label: model }))}
        />
      ) : (
        <TextField
          label="Image model"
          value={draft.model}
          onChange={(model) => patch({ model })}
          placeholder="gpt-image-1"
          hint="Fetch models above to pick from a list, or type the id directly."
        />
      )}

      <SelectField
        label="Default aspect ratio"
        value={draft.defaultAspect}
        onChange={(defaultAspect) => patch({ defaultAspect })}
        options={ASPECT_RATIOS.map((a) => ({ value: a.value, label: `${a.label} (${a.size})` }))}
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
          <TextArea
            label="Prompt suffix"
            value={draft.promptSuffix}
            onChange={(promptSuffix) => patch({ promptSuffix })}
            hint="Appended to every prompt — house style, quality tags, safety wording."
          />
          <TextArea
            label="Negative prompt"
            value={draft.negativePrompt}
            onChange={(negativePrompt) => patch({ negativePrompt })}
            hint="Sent as negative_prompt where the provider supports it."
          />
          <TextArea
            label="Extra request body (JSON)"
            value={JSON.stringify(draft.extraBody ?? {}, null, 2)}
            onChange={(value) => {
              try {
                const parsed = JSON.parse(value || '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  patch({ extraBody: parsed as Record<string, unknown> });
                }
              } catch {
                /* keep the last valid value until the JSON parses */
              }
            }}
            hint='Merged into every request, e.g. {"quality": "hd"}. Invalid JSON is ignored.'
          />
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------- memory */

function MemorySection() {
  const state = useAppState();
  const actions = useActions();
  const s = state.settings;

  return (
    <>
      <Banner kind="info" title="Memory for very long stories">
        A months-long roleplay cannot resend its whole history every turn. The story summary
        compacts older scenes so the model keeps the plot while the token cost stays flat.
      </Banner>

      <h3 className="section-title">Story summary</h3>
      <Toggle
        label="Use story summaries in the AI context"
        description="Older messages are replaced by the summary instead of being silently dropped."
        checked={s.useStorySummary}
        onChange={(useStorySummary) => actions.saveSettings({ useStorySummary })}
      />
      <NumberField
        label="Verbatim window (messages)"
        value={s.summaryWindow}
        onChange={(summaryWindow) =>
          actions.saveSettings({ summaryWindow: Math.max(4, Math.round(summaryWindow)) })
        }
        min={4}
        max={200}
        hint="How many recent messages are always sent word-for-word."
      />
      <NumberField
        label="Refresh the summary every N new messages"
        value={s.autoSummaryEvery}
        onChange={(autoSummaryEvery) =>
          actions.saveSettings({ autoSummaryEvery: Math.max(0, Math.round(autoSummaryEvery)) })
        }
        min={0}
        max={200}
        hint="0 disables automatic refresh — you can still regenerate by hand from a chat's menu."
      />

      <hr className="divider" />

      <h3 className="section-title">Automatic memory</h3>
      <Toggle
        label="Create memories automatically"
        description="Watches for story beats worth remembering and saves one when a trigger fires. Everything it creates is an ordinary memory you can edit or delete."
        checked={s.autoMemory}
        onChange={(autoMemory) => actions.saveSettings({ autoMemory })}
      />

      {s.autoMemory && (
        <>
          <NumberField
            label="Check every N replies"
            value={s.autoMemoryEvery}
            onChange={(autoMemoryEvery) =>
              actions.saveSettings({ autoMemoryEvery: Math.max(1, Math.round(autoMemoryEvery)) })
            }
            min={1}
            max={50}
          />
          <div className="field">
            <span className="field-label">Triggers</span>
            <div className="field-hint" style={{ marginBottom: 8 }}>
              Only the selected kinds of beat create a memory.
            </div>
            <div className="chip-row">
              {AUTO_MEMORY_TRIGGERS.map((trigger) => {
                const on = s.autoMemoryTriggers.includes(trigger.value);
                return (
                  <button
                    key={trigger.value}
                    type="button"
                    className={`chip ${on ? 'chip-accent' : ''}`}
                    style={{ cursor: 'pointer', minHeight: 40, padding: '0 14px' }}
                    aria-pressed={on}
                    onClick={() =>
                      actions.saveSettings({
                        autoMemoryTriggers: on
                          ? s.autoMemoryTriggers.filter((v) => v !== trigger.value)
                          : [...s.autoMemoryTriggers, trigger.value],
                      })
                    }
                  >
                    {trigger.label}
                  </button>
                );
              })}
            </div>
          </div>
          <Toggle
            label="Pin automatic memories"
            description="Off (recommended): they behave like any other memory. On: they are always forced into the context."
            checked={s.autoMemoryPin}
            onChange={(autoMemoryPin) => actions.saveSettings({ autoMemoryPin })}
          />
        </>
      )}

      <hr className="divider" />
      <p className="small muted">
        {state.memories.filter((m) => m.origin === 'auto').length} memory/ies were created
        automatically. They appear in the Memories tab tagged “auto”.
      </p>
    </>
  );
}
