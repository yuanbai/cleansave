import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Plus,
  Library as LibraryIcon,
  Activity as ActivityIcon,
  Settings as SettingsIcon,
  ArrowLeft,
  X,
  Link as LinkIcon,
  Download,
  RefreshCw,
  Image as ImageIcon,
  Video,
  LayoutGrid,
  List as ListIcon,
} from 'lucide-react';
import { CleanSaveClient, ApiError, type Settings } from '@cleansave/client';
import {
  metricNames,
  type Accepted,
  type Candidate,
  type Count,
  type CountCapture,
  type MetricName,
  type RecordDto,
  type RecordSummary,
} from '@cleansave/contracts';
import { translator, messages, type Translate, type MessageKey } from './i18n';
import s from './app.module.css';

const api = new CleanSaveClient({ baseUrl: '' });
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
const secret = new URLSearchParams(window.location.hash.slice(1)).get('pair');
if (secret)
  window.history.replaceState(null, '', window.location.pathname + window.location.search);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not finish.';
}

function ErrorNotice({ error }: { error: unknown }): ReactNode {
  return error ? (
    <p className={s.error} role="alert">
      {errorText(error)}
    </p>
  ) : null;
}

function date(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
    : '—';
}

function countLabel(value: Count | null | undefined, t: Translate): string {
  if (!value) return '—';
  if (value.kind === 'rounded') return value.display + ' · ' + t('rounded');
  return BigInt(value.value).toLocaleString();
}

function stateLabel(state: string, t: Translate): string {
  return state in messages ? t(state as MessageKey) : state.replaceAll('_', ' ');
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={s.modal}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={s.modalHead}>
        <h2>{title}</h2>
        <button aria-label="Close" className={s.iconButton} onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function App(): ReactNode {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      try {
        return await api.settings();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401 || !secret) throw error;
        await api.pair(secret);
        return api.settings();
      }
    },
  });
  const t = translator(settings.data?.language ?? 'en');
  useEffect(() => {
    const acceptPairingLink = (): void => {
      // Same-page pairing links change only the hash; rerun bootstrap to consume the new secret.
      if (new URLSearchParams(window.location.hash.slice(1)).has('pair')) window.location.reload();
    };
    window.addEventListener('hashchange', acceptPairingLink);
    return () => window.removeEventListener('hashchange', acceptPairingLink);
  }, []);
  useEffect(() => {
    document.documentElement.lang = settings.data?.language ?? 'en';
    document.documentElement.dataset.theme = settings.data?.theme ?? 'system';
  }, [settings.data?.language, settings.data?.theme]);
  useEffect(() => {
    if (!settings.data) return;
    const events = new EventSource('/api/v1/events');
    const invalidate = (): void => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          ['records', 'record', 'jobs', 'history', 'storage'].includes(String(query.queryKey[0])),
      });
    };
    events.addEventListener('changed', invalidate);
    events.addEventListener('resync_required', invalidate);
    return () => events.close();
  }, [settings.data]);
  if (settings.isPending)
    return (
      <main className={s.connect}>
        <h1>CleanSave</h1>
        <p>{t('loading')}</p>
      </main>
    );
  if (settings.isError) {
    const needsPairing = settings.error instanceof ApiError && settings.error.status === 401;
    return (
      <main className={s.connect}>
        <h1>CleanSave</h1>
        <h2>{t(needsPairing ? 'pairTitle' : 'connectionTitle')}</h2>
        <p>{t(needsPairing ? 'pairHint' : 'connectionHint')}</p>
        <ErrorNotice error={needsPairing ? null : settings.error} />
        <button
          onClick={() => {
            void settings.refetch();
          }}
        >
          {t('retryConnection')}
        </button>
      </main>
    );
  }
  return (
    <>
      <header className={s.header}>
        <Link to="/" className={s.brand}>
          <span className={s.brandIcon}>
            <Download size={18} />
          </span>
          CleanSave
        </Link>
        <nav aria-label="Main">
          <NavLink to="/" end>
            <LibraryIcon size={17} />
            <span>{t('library')}</span>
          </NavLink>
          <NavLink to="/activity">
            <ActivityIcon size={17} />
            <span>{t('activity')}</span>
          </NavLink>
          <NavLink to="/settings">
            <SettingsIcon size={17} />
            <span>{t('settings')}</span>
          </NavLink>
        </nav>
        <Link to="/add" className={s.primary}>
          <Plus size={17} />
          {t('add')}
        </Link>
      </header>
      <main className={s.main}>
        <Routes>
          <Route path="/" element={<Library t={t} />} />
          <Route
            path="/add"
            element={
              <>
                <Library t={t} />
                <AddLink t={t} defaults={settings.data} />
              </>
            }
          />
          <Route path="/records/:id" element={<Detail t={t} />} />
          <Route path="/activity" element={<Activity t={t} />} />
          <Route path="/settings" element={<Preferences t={t} settings={settings.data} />} />
          <Route path="*" element={<Link to="/">{t('back')}</Link>} />
        </Routes>
      </main>
    </>
  );
}

function Library({ t }: { t: Translate }): ReactNode {
  const [search, setSearch] = useSearchParams();
  const [view, setView] = useState(localStorage.getItem('cleansave-view') ?? 'grid');
  const filters = {
    query: search.get('query') ?? '',
    ...(search.get('platform')
      ? { platform: search.get('platform') as RecordSummary['platform'] }
      : {}),
    ...(search.get('kind') ? { kind: search.get('kind') as 'image' | 'video' } : {}),
    ...(search.get('state') ? { state: search.get('state') ?? '' } : {}),
    ...(search.get('tag') ? { tag: search.get('tag') ?? '' } : {}),
    order: search.get('order') === 'asc' ? ('asc' as const) : ('desc' as const),
  };
  const records = useInfiniteQuery({
    queryKey: ['records', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.list({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 3000,
  });
  const update = (name: string, value: string): void => {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearch(next, { replace: true });
  };
  const items = records.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <div className={s.titleRow}>
        <div>
          <h1>{t('library')}</h1>
          <p className={s.muted}>
            {t('records')}: {items.length}
            {records.hasNextPage ? '+' : ''}
          </p>
        </div>
        <div className={s.segment}>
          <button
            aria-label={t('grid')}
            aria-pressed={view === 'grid'}
            onClick={() => {
              setView('grid');
              localStorage.setItem('cleansave-view', 'grid');
            }}
          >
            <LayoutGrid size={18} />
          </button>
          <button
            aria-label={t('list')}
            aria-pressed={view === 'list'}
            onClick={() => {
              setView('list');
              localStorage.setItem('cleansave-view', 'list');
            }}
          >
            <ListIcon size={18} />
          </button>
        </div>
      </div>
      <div className={s.filters}>
        <input
          className={s.search}
          aria-label={t('search')}
          placeholder={t('search')}
          value={filters.query}
          onChange={(event) => update('query', event.target.value)}
        />
        <select
          aria-label={t('allPlatforms')}
          value={search.get('platform') ?? ''}
          onChange={(event) => update('platform', event.target.value)}
        >
          <option value="">{t('allPlatforms')}</option>
          {['douyin', 'xiaohongshu', 'kuaishou', 'tiktok', 'youtube'].map((platform) => (
            <option key={platform}>{platform}</option>
          ))}
        </select>
        <select
          aria-label={t('allTypes')}
          value={search.get('kind') ?? ''}
          onChange={(event) => update('kind', event.target.value)}
        >
          <option value="">{t('allTypes')}</option>
          <option value="image">{t('image')}</option>
          <option value="video">{t('video')}</option>
        </select>
        <select
          aria-label={t('allStates')}
          value={search.get('state') ?? ''}
          onChange={(event) => update('state', event.target.value)}
        >
          <option value="">{t('allStates')}</option>
          {[
            'complete',
            'partial',
            'not_requested',
            'queued',
            'downloading',
            'failed',
            'cancelled',
          ].map((state) => (
            <option key={state} value={state}>
              {stateLabel(state, t)}
            </option>
          ))}
        </select>
        <input
          aria-label={t('tag')}
          placeholder={t('tag')}
          value={search.get('tag') ?? ''}
          onChange={(event) => update('tag', event.target.value)}
        />
        <select
          aria-label="Order"
          value={filters.order}
          onChange={(event) => update('order', event.target.value)}
        >
          <option value="desc">{t('newest')}</option>
          <option value="asc">{t('oldest')}</option>
        </select>
      </div>
      <ErrorNotice error={records.error} />
      {records.isPending ? (
        <p>{t('loading')}</p>
      ) : !items.length ? (
        <div className={s.empty}>
          <LinkIcon size={32} />
          <h2>{search.size ? t('noMatches') : t('empty')}</h2>
          <Link to="/add" className={s.primary}>
            <Plus size={17} />
            {t('add')}
          </Link>
        </div>
      ) : (
        <div className={view === 'list' ? s.recordList : s.grid}>
          {items.map((record) => (
            <Link to={'/records/' + record.id} className={s.card} key={record.id}>
              <div className={s.preview}>
                {record.previewAssetId ? (
                  <img src={api.assetUrl(record.previewAssetId)} alt="" loading="lazy" />
                ) : record.kind === 'video' ? (
                  <Video size={30} />
                ) : (
                  <ImageIcon size={30} />
                )}
                <span className={s.platform}>{record.platform}</span>
              </div>
              <div className={s.cardBody}>
                <h3>{record.title || record.postId || t('loading')}</h3>
                <p className={s.muted}>{record.author || record.platform}</p>
                <div className={s.cardFoot}>
                  <span className={s.badge}>
                    {stateLabel(
                      record.resolutionState === 'failed' ? 'failed' : record.downloadState,
                      t,
                    )}
                  </span>
                  <span>
                    {record.itemCount > 1
                      ? record.retainedCount + '/' + record.itemCount + ' · '
                      : ''}
                    {date(record.savedAt)}
                  </span>
                </div>
                {record.tags.length > 0 && <p className={s.tags}>{record.tags.join(' · ')}</p>}
              </div>
            </Link>
          ))}
        </div>
      )}
      {records.hasNextPage && (
        <button
          className={s.more}
          disabled={records.isFetchingNextPage}
          onClick={() => {
            void records.fetchNextPage();
          }}
        >
          {t('loadMore')}
        </button>
      )}
    </>
  );
}

function AddLink({ t, defaults }: { t: Translate; defaults: Settings }): ReactNode {
  const navigate = useNavigate();
  const query = useQueryClient();
  const [input, setInput] = useState('');
  const [download, setDownload] = useState(defaults.downloadContent);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const options = await api.inspect(input);
      if (!options.length) throw new Error('No supported link was found.');
      if (options.length > 1 && !selected) {
        setCandidates(options);
        return null;
      }
      return api.create({
        input,
        ...(selected ? { selectedUrl: selected } : {}),
        downloadContent: download,
        requireNoWatermark: true,
      });
    },
    onSuccess: (result) => {
      if (!result) return;
      void query.invalidateQueries({ queryKey: ['records'] });
      void navigate(
        '/records/' + result.recordId + '?notice=' + (result.reused ? 'duplicate' : 'savedLabel'),
      );
    },
  });
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Modal title={t('add')} onClose={() => navigate('/')}>
      <form onSubmit={submit}>
        <label className={s.field}>
          {t('paste')}
          <textarea
            autoFocus
            rows={5}
            placeholder={t('inputHint')}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setCandidates([]);
              setSelected('');
            }}
          />
        </label>
        {candidates.length > 1 && (
          <fieldset>
            <legend>{t('choose')}</legend>
            {candidates.map((candidate) => (
              <label className={s.choice} key={candidate.url}>
                <input
                  type="radio"
                  name="candidate"
                  value={candidate.url}
                  checked={selected === candidate.url}
                  onChange={() => setSelected(candidate.url)}
                />
                <span>
                  {candidate.platform}
                  <small>{candidate.url}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label className={s.check}>
          <input
            type="checkbox"
            checked={download}
            onChange={(event) => setDownload(event.target.checked)}
          />
          {t('download')}
        </label>
        <p className={s.helper}>{t('metadataHint')}</p>
        <ErrorNotice error={save.error} />
        <div className={s.actions}>
          <button type="button" onClick={() => navigate('/')}>
            {t('cancel')}
          </button>
          <button
            className={s.primary}
            disabled={!input.trim() || save.isPending || (candidates.length > 1 && !selected)}
          >
            {save.isPending ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Detail({ t }: { t: Translate }): ReactNode {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const record = useQuery({
    queryKey: ['record', id],
    queryFn: () => api.getRecord(id),
    refetchInterval: (query) => (query.state.data?.activeJobIds.length ? 1200 : 5000),
  });
  useEffect(() => {
    if (record.data?.mergedIntoId)
      void navigate('/records/' + record.data.mergedIntoId + '?notice=duplicate', {
        replace: true,
      });
  }, [navigate, record.data?.mergedIntoId]);
  if (record.isPending) return <p>{t('loading')}</p>;
  if (!record.data)
    return (
      <>
        <Link to="/">{t('back')}</Link>
        <ErrorNotice error={record.error} />
      </>
    );
  return (
    <RecordDetail
      key={record.data.id}
      record={record.data}
      t={t}
      notice={search.get('notice') ?? ''}
    />
  );
}

/** Retry resolution while requiring clean sources for any requested follow-up download. */
async function retryResolution(record: RecordDto): Promise<Accepted> {
  if (record.options.downloadContent && !record.options.requireNoWatermark) {
    // Reusing the saved link updates pending download intent without replacing captured metadata.
    return api.create({
      input: record.originalUrl,
      downloadContent: true,
      requireNoWatermark: true,
    });
  }
  return api.resolve(record.id);
}

/** Show a four-line caption preview, with expansion only when its rendered text overflows. */
function PostDescription({ text, t }: { text: string; t: Translate }): ReactNode {
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = (): void => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      setOverflows(element.scrollHeight > lineHeight * 4 + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  if (!text) return null;
  return (
    <div className={s.postDescription}>
      <p
        ref={paragraph}
        id={id}
        className={`${s.description} ${expanded ? '' : s.descriptionCollapsed}`}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          className={s.descriptionToggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {t(expanded ? 'showLess' : 'showMore')}
        </button>
      )}
    </div>
  );
}

function RecordDetail({
  record,
  t,
  notice,
}: {
  record: RecordDto;
  t: Translate;
  notice: string;
}): ReactNode {
  const query = useQueryClient();
  const navigate = useNavigate();
  const [confirmation, setConfirmation] = useState<'remove' | 'delete' | null>(null);
  const invalidate = (): void => {
    void query.invalidateQueries({ queryKey: ['record', record.id] });
    void query.invalidateQueries({ queryKey: ['history', record.id] });
  };
  const action = useMutation({
    mutationFn: async (type: 'refresh' | 'download' | 'resolve' | 'remove' | 'delete') => {
      if (type === 'refresh') return api.refresh(record.id);
      if (type === 'download') return api.download(record.id, true);
      if (type === 'resolve') return retryResolution(record);
      if (type === 'remove') return api.removeDownloads(record.id);
      return api.deleteRecord(record.id);
    },
    onSuccess: (_result, type) => {
      setConfirmation(null);
      invalidate();
      if (type === 'delete') void navigate('/');
    },
  });
  const active = useQuery({
    queryKey: ['jobs', record.id, record.activeJobIds],
    queryFn: () => Promise.all(record.activeJobIds.map((id) => api.getJob(id))),
    enabled: record.activeJobIds.length > 0,
    refetchInterval: 1200,
  });
  const hasDownloads = record.assets.some((asset) => asset.state === 'complete');
  return (
    <>
      <Link to="/" className={s.back}>
        <ArrowLeft size={16} />
        {t('back')}
      </Link>
      {notice in messages && (
        <p className={s.success} role="status">
          {t(notice as MessageKey)}
        </p>
      )}
      <div className={s.detailGrid}>
        <section>
          <div className={s.viewer}>
            {record.media.filter((media) => media.required).length ? (
              record.media
                .filter((media) => media.required)
                .map((media) => {
                  const asset = record.assets.find(
                    (value) =>
                      value.itemId === media.itemId &&
                      value.variantId === media.variantId &&
                      value.state === 'complete',
                  );
                  return (
                    <div className={s.mediaItem} key={media.itemId}>
                      {asset ? (
                        asset.kind === 'video' ? (
                          <video controls preload="metadata" src={api.assetUrl(asset.id)} />
                        ) : (
                          <img
                            src={api.assetUrl(asset.id)}
                            alt={`${t('image')} ${media.position + 1}`}
                          />
                        )
                      ) : (
                        <div className={s.mediaPlaceholder}>
                          {media.kind === 'video' ? <Video size={38} /> : <ImageIcon size={38} />}
                          <p>{t('notDownloaded')}</p>
                          {record.media.length > 1 && (
                            <small>
                              {media.position + 1}/{record.media.length}
                            </small>
                          )}
                        </div>
                      )}
                      {asset && (
                        <a href={api.assetUrl(asset.id)} download>
                          {t('download')} · {formatBytes(asset.bytes)}
                        </a>
                      )}
                    </div>
                  );
                })
            ) : (
              <div className={s.mediaPlaceholder}>
                <LinkIcon size={32} />
                <p>{stateLabel(record.resolutionState, t)}</p>
              </div>
            )}
          </div>
          <section className={s.panel} aria-labelledby="post-details-heading">
            <div className={s.titleRow}>
              <h1 id="post-details-heading" className={s.postDetailsTitle}>
                {t('postDetails')}
              </h1>
              <a className={s.button} href={`/api/v1/records/${record.id}/export`} download>
                {t('export')}
              </a>
            </div>
            <div className={s.recordIdentity}>
              {record.metadata?.author.name && (
                <strong className={s.recordAuthor}>{record.metadata.author.name}</strong>
              )}
              <span className={s.badge}>{record.platform}</span>
              <p className={s.savedDate}>
                {t('saved')} <time dateTime={record.savedAt}>{date(record.savedAt)}</time>
              </p>
            </div>
            <PostDescription
              text={record.metadata?.description || record.metadata?.title || ''}
              t={t}
            />
            <a href={record.originalUrl} target="_blank" rel="noreferrer" className={s.sourceUrl}>
              {record.originalUrl}
            </a>
            <p className={s.muted}>
              {t('captured')}: {date(record.metadata?.capturedAt ?? null)}
            </p>
            {record.metadata?.warnings.map((warning) => (
              <p className={s.warning} key={warning}>
                {warning.replaceAll('_', ' ')}
              </p>
            ))}
            <div className={s.actions}>
              <button
                className={s.danger}
                disabled={action.isPending}
                onClick={() => setConfirmation('delete')}
              >
                {t('deleteRecord')}
              </button>
            </div>
          </section>
          <CountsHistory id={record.id} t={t} />
        </section>
        <aside>
          <section className={s.panel}>
            <div className={s.titleRow}>
              <h2>{t('countSummary')}</h2>
            </div>
            <div className={s.metricGrid}>
              {metricNames.map((metric) => (
                <div key={metric}>
                  <small>{t(metric)}</small>
                  <strong>{countLabel(record.counts?.counts[metric], t)}</strong>
                </div>
              ))}
            </div>
            <button
              className={s.full}
              disabled={
                action.isPending ||
                !record.metadata ||
                active.data?.some((job) => job.type === 'refresh')
              }
              onClick={() => action.mutate('refresh')}
            >
              <RefreshCw size={16} />
              {t('refresh')}
            </button>
            <p className={s.helper}>{t('refreshHint')}</p>
            {record.refreshError && (
              <p className={s.error} role="alert">
                {record.refreshError.message}
              </p>
            )}
          </section>
          <section className={s.panel} aria-labelledby="download-heading">
            <div className={s.titleRow}>
              <h2 id="download-heading">{t('download')}</h2>
              <span className={s.badge}>{stateLabel(record.downloadState, t)}</span>
            </div>
            {(record.downloadState !== 'complete' || hasDownloads) && (
              <div className={s.downloadActions}>
                {record.downloadState !== 'complete' && (
                  <button
                    className={`${s.primary} ${s.full}`}
                    disabled={
                      action.isPending ||
                      !record.metadata ||
                      active.data?.some((job) => job.type === 'download')
                    }
                    onClick={() => action.mutate('download')}
                  >
                    <Download size={16} />
                    {t('downloadMissing')}
                  </button>
                )}
                {hasDownloads && (
                  <button disabled={action.isPending} onClick={() => setConfirmation('remove')}>
                    {t('removeFiles')}
                  </button>
                )}
              </div>
            )}
            {record.resolutionState === 'failed' && (
              <button onClick={() => action.mutate('resolve')}>{t('resolve')}</button>
            )}
            {record.error && (
              <p className={s.error} role="alert">
                {record.error.message}
              </p>
            )}
            <ErrorNotice error={action.error} />
            {active.data
              ?.filter((job) => ['queued', 'running'].includes(job.state))
              .map((job) => (
                <div className={s.job} key={job.id}>
                  <span>
                    {stateLabel(job.type, t)} · {stateLabel(job.state, t)}
                  </span>
                  <small>
                    {job.completedItems}/{job.totalItems || '—'} · {formatBytes(job.bytes)}
                  </small>
                  {job.type !== 'delete' && job.type !== 'remove_downloads' && (
                    <button
                      onClick={() => {
                        void api
                          .cancelJob(job.id)
                          .then(invalidate)
                          .catch((error) => window.alert(errorText(error)));
                      }}
                    >
                      {t('cancel')}
                    </button>
                  )}
                </div>
              ))}
            {record.assets.length > 0 && (
              <div className={s.downloadFiles}>
                {record.assets.map((asset) => (
                  <div className={s.receipt} key={asset.id}>
                    <strong>
                      {asset.kind} · {formatBytes(asset.bytes)}
                    </strong>
                    <small>
                      {asset.mime} · {asset.watermarkStatus}
                    </small>
                    <small>{asset.validation}</small>
                    <code title={asset.sha256}>SHA-256 {asset.sha256.slice(0, 16)}…</code>
                  </div>
                ))}
              </div>
            )}
          </section>
          <Annotations record={record} t={t} />
        </aside>
      </div>
      {confirmation && (
        <Modal
          title={t(confirmation === 'delete' ? 'deleteRecord' : 'removeFiles')}
          onClose={() => setConfirmation(null)}
        >
          <p>{t(confirmation === 'delete' ? 'deleteHint' : 'removeHint')}</p>
          <ErrorNotice error={action.error} />
          <div className={s.actions}>
            <button onClick={() => setConfirmation(null)}>{t('cancel')}</button>
            <button
              className={s.danger}
              disabled={action.isPending}
              onClick={() => action.mutate(confirmation)}
            >
              {t('confirm')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function Annotations({ record, t }: { record: RecordDto; t: Translate }): ReactNode {
  const query = useQueryClient();
  const [note, setNote] = useState(record.note);
  const [tags, setTags] = useState(record.tags.join(', '));
  const [revision, setRevision] = useState(record.annotationRevision);
  const [saved, setSaved] = useState(false);
  const dirty = note !== record.note || tags !== record.tags.join(', ');
  const mutation = useMutation({
    mutationFn: () =>
      api.annotate(record.id, {
        expectedRevision: revision,
        note,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    onSuccess: (updated) => {
      setRevision(updated.annotationRevision);
      setNote(updated.note);
      setTags(updated.tags.join(', '));
      setSaved(true);
      void query.invalidateQueries({ queryKey: ['record', record.id] });
    },
  });
  return (
    <section className={s.panel}>
      <h2>{t('notes')}</h2>
      <label className={s.field}>
        {t('notes')}
        <textarea
          aria-label={t('notes')}
          rows={5}
          value={note}
          maxLength={20000}
          onChange={(event) => {
            setNote(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <label className={s.field}>
        {t('tags')}
        <input
          value={tags}
          onChange={(event) => {
            setTags(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <button disabled={!dirty || mutation.isPending} onClick={() => mutation.mutate()}>
        {t('saveEdits')}
      </button>
      {dirty && <small className={s.muted}>{t('draft')}</small>}
      {saved && (
        <p className={s.success} role="status">
          {t('editsSaved')}
        </p>
      )}
      <ErrorNotice error={mutation.error} />
      {record.annotationRevision !== revision && (
        <button
          onClick={() => {
            setNote(record.note);
            setTags(record.tags.join(', '));
            setRevision(record.annotationRevision);
            mutation.reset();
          }}
        >
          {t('reloadEdits')}
        </button>
      )}
      {record.annotationDrafts.map((draft, index) => (
        <details key={index}>
          <summary>
            {t('draft')} {index + 1}
          </summary>
          <p>{draft.note}</p>
          <p>{draft.tags.join(', ')}</p>
        </details>
      ))}
    </section>
  );
}

/** Format a date for a minute-precision input using the browser's local timezone. */
function localDateTime(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function CountsHistory({ id, t }: { id: string; t: Translate }): ReactNode {
  const [metric, setMetric] = useState<MetricName>('likes');
  const [windowDays, setWindowDays] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const rangeErrorId = useId();
  const invalidRange = from !== '' && to !== '' && Date.parse(from) >= Date.parse(to);
  const [window, setWindow] = useState<{ from?: string; to?: string }>({});

  /** Apply valid date bounds immediately; retain the chart during incomplete or invalid input. */
  function updateCustomWindow(nextFrom: string, nextTo: string): void {
    const inputsValid = fromInput.current?.validity.valid && toInput.current?.validity.valid;
    setWindowDays(inputsValid && !nextFrom && !nextTo ? 'all' : 'custom');
    if (!inputsValid) return;
    const start = nextFrom ? new Date(nextFrom) : null;
    const end = nextTo ? new Date(nextTo) : null;
    if ((start && !Number.isFinite(start.getTime())) || (end && !Number.isFinite(end.getTime()))) {
      return;
    }
    if (start && end && start.getTime() >= end.getTime()) return;
    setWindow({
      ...(start ? { from: start.toISOString() } : {}),
      ...(end ? { to: end.toISOString() } : {}),
    });
  }

  const history = useInfiniteQuery({
    queryKey: ['history', id, window],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.history(id, { ...window, limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Retain this record's results while a new window loads to prevent scroll jumps.
    placeholderData: (data, previousQuery) =>
      previousQuery?.queryKey[1] === id ? data : undefined,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className={s.panel}>
      <div className={s.titleRow}>
        <h2>{t('counts')}</h2>
        <select
          aria-label="Count window"
          value={windowDays}
          onChange={(event) => {
            const value = event.target.value;
            setWindowDays(value);
            if (value === 'all') {
              setFrom('');
              setTo('');
              setWindow({});
            } else if (value === '7' || value === '30') {
              // Use the next minute boundary so the exclusive end includes the current minute.
              const end = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
              const start = new Date(end.getTime() - Number(value) * 86_400_000);
              setFrom(localDateTime(start));
              setTo(localDateTime(end));
              setWindow({ from: start.toISOString(), to: end.toISOString() });
            }
          }}
        >
          <option value="all">{t('allTime')}</option>
          <option value="7">{t('days7')}</option>
          <option value="30">{t('days30')}</option>
          {windowDays === 'custom' && <option value="custom">{t('customRange')}</option>}
        </select>
      </div>
      <div className={s.segment}>
        {metricNames.map((name) => (
          <button key={name} aria-pressed={name === metric} onClick={() => setMetric(name)}>
            {t(name)}
          </button>
        ))}
      </div>
      <div className={s.dateWindow}>
        <label>
          {t('from')}
          <input
            type="datetime-local"
            ref={fromInput}
            value={from}
            aria-invalid={invalidRange || undefined}
            aria-describedby={invalidRange ? rangeErrorId : undefined}
            onChange={(event) => {
              setFrom(event.target.value);
              updateCustomWindow(event.target.value, to);
            }}
          />
        </label>
        <label>
          {t('to')}
          <input
            type="datetime-local"
            ref={toInput}
            value={to}
            aria-invalid={invalidRange || undefined}
            aria-describedby={invalidRange ? rangeErrorId : undefined}
            onChange={(event) => {
              setTo(event.target.value);
              updateCustomWindow(from, event.target.value);
            }}
          />
        </label>
      </div>
      {invalidRange && (
        <p id={rangeErrorId} className={s.error} role="alert">
          {t('invalidCountRange')}
        </p>
      )}
      <ErrorNotice error={history.error} />
      <div className={s.historyResults} aria-busy={history.isFetching}>
        {history.isFetching && !history.isPending && (
          <span className={s.historyLoading} role="status">
            {t('loading')}
          </span>
        )}
        {items.length ? (
          <>
            <Chart items={items} metric={metric} t={t} />
            {items.length === 1 && <p className={s.helper}>{t('onePoint')}</p>}
            <p className={s.helper}>{t('observationHint')}</p>
            <div className={s.tableScroll}>
              <table>
                <thead>
                  <tr>
                    <th>{t('timestamp')}</th>
                    {metricNames.map((name) => (
                      <th key={name}>{t(name)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <time dateTime={item.capturedAt}>{date(item.capturedAt)}</time>
                      </td>
                      {metricNames.map((name) => (
                        <td key={name} title={!item.counts[name] ? t('unavailable') : undefined}>
                          {countLabel(item.counts[name], t)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className={s.muted}>{history.isPending ? t('loading') : t('noCounts')}</p>
        )}
      </div>
      {history.hasNextPage && (
        <button
          onClick={() => {
            void history.fetchNextPage();
          }}
          disabled={history.isFetchingNextPage || history.isPlaceholderData}
        >
          {t('loadMore')}
        </button>
      )}
    </section>
  );
}

function Chart({
  items,
  metric,
  t,
}: {
  items: CountCapture[];
  metric: MetricName;
  t: Translate;
}): ReactNode {
  const values = items.map((item) => {
    const count = item.counts[metric];
    return count?.kind === 'exact' && BigInt(count.value) <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(count.value)
      : null;
  });
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const first = Date.parse(items[0]?.capturedAt ?? '');
  const last = Date.parse(items.at(-1)?.capturedAt ?? '');
  const points = values.map((value, index) => {
    const timestamp = Date.parse(items[index]?.capturedAt ?? '');
    return value === null
      ? null
      : {
          x: last === first ? 350 : 50 + ((timestamp - first) / (last - first)) * 620,
          y: 170 - (value / max) * 140,
          value,
          index,
        };
  });
  const paths: string[] = [];
  let current = '';
  for (const point of points) {
    if (!point) {
      if (current) paths.push(current);
      current = '';
    } else current += `${current ? ' L' : 'M'}${point.x},${point.y}`;
  }
  if (current) paths.push(current);
  return (
    <svg
      className={s.chart}
      viewBox="0 0 700 205"
      role="img"
      aria-label={t(metric) + ' · ' + t('counts')}
    >
      <line x1="50" y1="30" x2="670" y2="30" />
      <line x1="50" y1="100" x2="670" y2="100" />
      <line x1="50" y1="170" x2="670" y2="170" />
      <text x="4" y="34">
        {max.toLocaleString(undefined, { notation: 'compact' })}
      </text>
      <text x="18" y="174">
        0
      </text>
      {paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
      {points.map(
        (point) =>
          point && (
            <circle key={point.index} cx={point.x} cy={point.y} r="4" tabIndex={0}>
              <title>
                {date(items[point.index]?.capturedAt ?? null)} · {point.value.toLocaleString()}
              </title>
            </circle>
          ),
      )}
      <text x="50" y="198">
        {new Date(first).toLocaleDateString()}
      </text>
      <text x="670" y="198" textAnchor="end">
        {new Date(last).toLocaleDateString()}
      </text>
    </svg>
  );
}

function Activity({ t }: { t: Translate }): ReactNode {
  const query = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs(), refetchInterval: 1500 });
  const action = useMutation({
    mutationFn: async ({ id, type }: { id: string; type: 'cancel' | 'retry' }): Promise<void> => {
      if (type === 'cancel') {
        await api.cancelJob(id);
      } else {
        const job = await api.getJob(id);
        if (job.type === 'download') await api.download(job.recordId, true);
        else if (job.type === 'resolve') await retryResolution(await api.getRecord(job.recordId));
        else await api.retryJob(id);
      }
    },
    onSuccess: () => {
      void query.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  return (
    <>
      <h1>{t('activity')}</h1>
      <ErrorNotice error={jobs.error || action.error} />
      {!jobs.data?.length && (
        <div className={s.empty}>
          <p>{t('noJobs')}</p>
        </div>
      )}
      {jobs.data?.map((job) => (
        <section className={`${s.panel} ${s.activityJob}`} key={job.id}>
          <Link to={'/records/' + job.recordId}>
            {stateLabel(job.type, t)}
            <small>{date(job.createdAt)}</small>
          </Link>
          <span className={s.badge}>{stateLabel(job.state, t)}</span>
          <span>
            {job.completedItems}/{job.totalItems || '—'} · {formatBytes(job.bytes)}
          </span>
          {['queued', 'running'].includes(job.state) &&
          job.type !== 'delete' &&
          job.type !== 'remove_downloads' ? (
            <button
              disabled={action.isPending}
              onClick={() => action.mutate({ id: job.id, type: 'cancel' })}
            >
              {t('cancel')}
            </button>
          ) : ['failed', 'cancelled', 'interrupted'].includes(job.state) ? (
            <button
              disabled={action.isPending}
              onClick={() => action.mutate({ id: job.id, type: 'retry' })}
            >
              {t('retry')}
            </button>
          ) : null}
          {job.error && <p className={s.error}>{job.error.message}</p>}
        </section>
      ))}
    </>
  );
}

function Preferences({ t, settings }: { t: Translate; settings: Settings }): ReactNode {
  const query = useQueryClient();
  const [pendingSettings, setPendingSettings] = useState(settings);
  const mutation = useMutation({
    mutationFn: (value: Settings) => api.setSettings(value),
    onMutate: async (value) => {
      await query.cancelQueries({ queryKey: ['settings'] });
      const previous = query.getQueryData<Settings>(['settings']) ?? settings;
      query.setQueryData(['settings'], value);
      return previous;
    },
    onSuccess: (updated) => query.setQueryData(['settings'], updated),
    onError: (_error, _variables, previous) => {
      if (previous) query.setQueryData(['settings'], previous);
    },
  });
  const currentSettings = mutation.isPending ? pendingSettings : settings;

  /** Update controlled inputs synchronously while their optimistic save starts. */
  function updateSettings(value: Settings): void {
    setPendingSettings(value);
    mutation.mutate(value);
  }

  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: () => api.capabilities() });
  const storage = useQuery({
    queryKey: ['storage'],
    queryFn: () => api.storageUsage(),
    refetchInterval: 5000,
  });
  return (
    <div className={s.preferences}>
      <h1>{t('settings')}</h1>
      <section className={s.panel} aria-busy={mutation.isPending}>
        <label className={s.field}>
          {t('appearance')}
          <select
            aria-label={t('appearance')}
            value={currentSettings.theme}
            disabled={mutation.isPending}
            onChange={(event) => {
              const theme = event.target.value;
              if (theme === 'system' || theme === 'light' || theme === 'dark') {
                updateSettings({ ...currentSettings, theme });
              }
            }}
          >
            <option value="system">{t('themeSystem')}</option>
            <option value="light">{t('themeLight')}</option>
            <option value="dark">{t('themeDark')}</option>
          </select>
        </label>
        <label className={s.field}>
          {t('language')}
          <select
            aria-label={t('language')}
            value={currentSettings.language}
            disabled={mutation.isPending}
            onChange={(event) => {
              const language = event.target.value;
              if (language === 'en' || language === 'zh-CN') {
                updateSettings({ ...currentSettings, language });
              }
            }}
          >
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </label>
        <h2>{t('defaults')}</h2>
        <label className={s.check}>
          <input
            type="checkbox"
            checked={currentSettings.downloadContent}
            disabled={mutation.isPending}
            onChange={(event) =>
              updateSettings({ ...currentSettings, downloadContent: event.target.checked })
            }
          />
          {t('download')}
        </label>
        <ErrorNotice error={mutation.error} />
      </section>
      <section className={s.panel} aria-labelledby="storage-heading">
        <h2 id="storage-heading">{t('storage')}</h2>
        <ErrorNotice error={storage.error} />
        {storage.isPending && <p>{t('loading')}</p>}
        {storage.data && (
          <div className={s.metricGrid}>
            <div>
              <small>{t('downloadedMedia')}</small>
              <strong>
                <output aria-label={t('downloadedMedia')}>
                  {formatBytes(storage.data.downloadBytes)}
                </output>
              </strong>
            </div>
            <div>
              <small>{t('downloadedFiles')}</small>
              <strong>
                <output aria-label={t('downloadedFiles')}>{storage.data.downloadedFiles}</output>
              </strong>
            </div>
          </div>
        )}
        <p className={s.helper}>{t('storageHint')}</p>
      </section>
      <section className={s.panel}>
        <h2>{t('capabilities')}</h2>
        <ErrorNotice error={capabilities.error} />
        {capabilities.data?.adapters.map((adapter) => (
          <div className={s.receipt} key={adapter.platform}>
            <strong>{adapter.platform}</strong>
            <p>
              {[adapter.images ? t('image') : '', adapter.video ? t('video') : '']
                .filter(Boolean)
                .join(' · ')}
            </p>
            {adapter.limitations.map((limit) => (
              <p className={s.helper} key={limit}>
                {limit}
              </p>
            ))}
          </div>
        ))}
      </section>
      <section className={s.panel}>
        <h2>{t('agentSetup')}</h2>
        <p>{t('agentHint')}</p>
        <code>cleansave mcp</code>
      </section>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024
    ? bytes + ' B'
    : bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + ' KB'
      : bytes < 1024 * 1024 * 1024
        ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
        : (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </QueryClientProvider>,
);
