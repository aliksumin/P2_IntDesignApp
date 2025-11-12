'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
  type Dispatch,
  type SetStateAction,
  type ChangeEvent,
} from 'react';
import clsx from 'clsx';
import { Stage, Layer, Line, Rect, Image as KonvaImage } from 'react-konva';
import useImage from 'use-image';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { simulateMaterialEdit, simulateRenderRequest } from '@/lib/mockApi';
import type {
  LayoutElement,
  LayoutElementType,
  WallGeometry,
  OpeningGeometry,
} from '@/types/layout';
import type { KonvaEventObject } from 'konva/lib/Node';

const layoutMetaSchema = z.object({
  layoutName: z.string().min(2, 'Name is required'),
  ceilingHeight: z.number().min(2.2).max(6),
  layoutNotes: z.string().max(300).optional(),
});

const renderSchema = z.object({
  prompt: z
    .string()
    .min(10, 'Prompt should describe the desired style')
    .max(600),
  stylePreset: z.string(),
  cameraHeight: z.number().min(0.5).max(3),
});

const materialSchema = z.object({
  elementId: z.string(),
  description: z.string().min(5),
  color: z.string(),
});

const settingsSchema = z.object({
  nanoBanana: z.string().optional(),
  assetStorage: z.string().optional(),
});

type LayoutMetaForm = z.infer<typeof layoutMetaSchema>;
type RenderForm = z.infer<typeof renderSchema>;
type MaterialForm = z.infer<typeof materialSchema>;
type SettingsForm = z.infer<typeof settingsSchema>;

type FurnitureSample = {
  id: string;
  name: string;
  size: number;
  previewUrl?: string;
  notes?: string;
};

type RenderJob = {
  id: string;
  prompt: string;
  stylePreset: string;
  status: 'idle' | 'queued' | 'processing' | 'complete';
  imageUrl?: string;
  createdAt: number;
};

type MaterialEdit = {
  id: string;
  targetElementId: string;
  description: string;
  color: string;
  status: 'queued' | 'applying' | 'complete';
  previewUrl?: string;
  createdAt: number;
};

type ApiKeys = {
  nanoBanana?: string;
  assetStorage?: string;
};

const stepData = [
  {
    id: 1,
    title: 'Layout',
    subtitle: 'Walls, doors, windows',
  },
  {
    id: 2,
    title: 'Render',
    subtitle: 'Perspective with Nano Banana',
  },
  {
    id: 3,
    title: 'Materials',
    subtitle: 'Targeted edits',
  },
];

const initialLayoutMeta = {
  layoutName: 'Open Living Space',
  ceilingHeight: 3.2,
  layoutNotes: 'North-facing windows, double door to balcony.',
};

const initialPrompt =
  'Modern Scandinavian living room with warm lighting and textured walls.';
const initialStylePreset = 'natural-soft';
const defaultColor = '#111111';
const defaultWallThicknessMm = 200;
type Point = { x: number; y: number };

const flattenPoints = (points: Point[]) =>
  points.flatMap((pt) => [Number(pt.x.toFixed(2)), Number(pt.y.toFixed(2))]);

const boundsFromPoints = (points: Point[]) => {
  if (points.length === 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;
  return {
    left,
    top,
    width: Math.max(width, 1),
    height: Math.max(height, 1),
  };
};

const mmToPx = (mm: number) => Math.max(4, mm / 10);

function PolylineIcon({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <polyline
        points="4 16 9 10 14 14 20 6"
        stroke={active ? '#1d4ed8' : '#475569'}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RectangleIcon({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect
        x="5"
        y="6"
        width="14"
        height="12"
        rx="2"
        ry="2"
        stroke={active ? '#1d4ed8' : '#475569'}
        strokeWidth="2"
      />
    </svg>
  );
}

function ArcIcon({ active }: { active?: boolean }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M5 18a9 9 0 0 1 9-9h5"
        stroke={active ? '#1d4ed8' : '#475569'}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DoorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="6" width="12" height="12" stroke="#f97316" strokeWidth="2" />
      <circle cx="14" cy="12" r="1" fill="#f97316" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="5" width="16" height="14" stroke="#3c6ff0" strokeWidth="2" />
      <path d="M12 5v14" stroke="#3c6ff0" strokeWidth="2" />
    </svg>
  );
}

const palette: Record<
  Exclude<LayoutElementType, 'wall'>,
  { label: string; fill: string; width: number; height: number; opacity: number }
> = {
  door: {
    label: 'Door',
    fill: '#f97316',
    width: 120,
    height: 18,
    opacity: 0.9,
  },
  window: {
    label: 'Window',
    fill: '#3c6ff0',
    width: 200,
    height: 18,
    opacity: 0.65,
  },
};

const wallTools = [
  { id: 'polyline', label: 'Polyline', icon: PolylineIcon },
  { id: 'rectangle', label: 'Rectangle', icon: RectangleIcon },
  { id: 'arc', label: 'Arc', icon: ArcIcon },
] as const;

type WallToolId = (typeof wallTools)[number]['id'];

const styles = [
  { id: 'natural-soft', label: 'Natural soft light' },
  { id: 'nocturnal', label: 'Moody evening' },
  { id: 'studio-crisp', label: 'Studio crisp' },
  { id: 'vignette', label: 'Vignette' },
];

const generateId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 11);

const timestamp = () => Date.now();

function formatDate(ts: number) {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

export default function HomePage() {
  const [activeStep, setActiveStep] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layoutMeta, setLayoutMeta] = useState(initialLayoutMeta);
  const [elements, setElements] = useState<LayoutElement[]>([]);
  const [furniture, setFurniture] = useState<FurnitureSample[]>([]);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [stylePreset, setStylePreset] = useState(initialStylePreset);
  const [renderJobs, setRenderJobs] = useState<RenderJob[]>([]);
  const [materialEdits, setMaterialEdits] = useState<MaterialEdit[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [wallThicknessMm, setWallThicknessMm] = useState(defaultWallThicknessMm);

  const handleSaveMeta = (values: LayoutMetaForm) => {
    setLayoutMeta({
      layoutName: values.layoutName,
      ceilingHeight: values.ceilingHeight,
      layoutNotes: values.layoutNotes ?? '',
    });
  };

  const addRenderJob = (job: RenderJob) =>
    setRenderJobs((prev) => [job, ...prev].slice(0, 5));

  const updateRenderJob = (jobId: string, patch: Partial<RenderJob>) =>
    setRenderJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, ...patch } : job)),
    );

  const addMaterialEdit = (edit: MaterialEdit) =>
    setMaterialEdits((prev) => [edit, ...prev].slice(0, 6));

  const updateMaterialEdit = (editId: string, patch: Partial<MaterialEdit>) =>
    setMaterialEdits((prev) =>
      prev.map((edit) => (edit.id === editId ? { ...edit, ...patch } : edit)),
    );

  const updateApiKey = (key: keyof ApiKeys, value: string) =>
    setApiKeys((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-4 rounded-3xl bg-white px-6 py-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.2em] text-slate-400">
              Nano Banana Studio
            </p>
            <h1 className="text-3xl font-semibold text-slate-900">P2 Interior Design Companion</h1>
            <p className="text-sm text-slate-500">
              Upload or sketch a plan, request renders, then refine materials in one place.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:border-slate-300"
              onClick={() => setSettingsOpen(true)}
            >
              API Settings
            </button>
          </div>
        </header>

        <nav className="flex flex-wrap gap-3">
          {stepData.map((step) => (
            <button
              key={step.id}
              onClick={() => setActiveStep(step.id)}
              className={clsx(
                'flex flex-1 min-w-[140px] flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition',
                activeStep === step.id
                  ? 'border-transparent bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
              )}
            >
              <span className="text-xs uppercase tracking-wide text-slate-400">
                Step {step.id}
              </span>
              <span className="text-base font-semibold">{step.title}</span>
              <span className="text-xs text-slate-500">{step.subtitle}</span>
            </button>
          ))}
        </nav>

        {activeStep === 1 && (
          <LayoutStage
            layoutName={layoutMeta.layoutName}
            ceilingHeight={layoutMeta.ceilingHeight}
            layoutNotes={layoutMeta.layoutNotes}
            elements={elements}
            onSaveMeta={handleSaveMeta}
            onElementsChange={setElements}
            wallThicknessMm={wallThicknessMm}
            onWallThicknessChange={setWallThicknessMm}
          />
        )}
        {activeStep === 2 && (
          <RenderStage
            layoutName={layoutMeta.layoutName}
            furniture={furniture}
            setFurniture={setFurniture}
            prompt={prompt}
            setPrompt={setPrompt}
            stylePreset={stylePreset}
            setStylePreset={setStylePreset}
            renderJobs={renderJobs}
            addRenderJob={addRenderJob}
            updateRenderJob={updateRenderJob}
          />
        )}
        {activeStep === 3 && (
          <MaterialStage
            elements={elements}
            materialEdits={materialEdits}
            addMaterialEdit={addMaterialEdit}
            updateMaterialEdit={updateMaterialEdit}
          />
        )}
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiKeys={apiKeys}
        setApiKey={updateApiKey}
      />
    </div>
  );
}

type MaterialStageProps = {
  elements: LayoutElement[];
  materialEdits: MaterialEdit[];
  addMaterialEdit: (edit: MaterialEdit) => void;
  updateMaterialEdit: (editId: string, patch: Partial<MaterialEdit>) => void;
};

function MaterialStage({
  elements,
  materialEdits,
  addMaterialEdit,
  updateMaterialEdit,
}: MaterialStageProps) {

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
  } = useForm<MaterialForm>({
    resolver: zodResolver(materialSchema),
    defaultValues: {
      elementId: elements[0]?.id ?? '',
      description: '',
      color: '#f5f5f4',
    },
  });

  useEffect(() => {
    if (elements.length === 0) {
      reset({ elementId: '', description: '', color: '#f5f5f4' });
      return;
    }
    setValue('elementId', elements[0].id);
  }, [elements, reset, setValue]);

  const mutation = useMutation({
    mutationFn: simulateMaterialEdit,
    onSuccess: ({ editId, previewUrl }) => {
      updateMaterialEdit(editId, { status: 'complete', previewUrl });
    },
  });

  const onSubmit = (values: MaterialForm) => {
    const target = elements.find((element) => element.id === values.elementId);
    if (!target) return;
    const editId = generateId();
    addMaterialEdit({
      id: editId,
      targetElementId: target.id,
      description: values.description,
      color: values.color,
      status: 'applying',
      createdAt: timestamp(),
    });
    mutation.mutate({
      editId,
      elementLabel: target.label,
      material: values.description,
      color: values.color,
    });
    reset({
      elementId: target.id,
      description: '',
      color: values.color,
    });
  };

  const disableForm = elements.length === 0;

  return (
    <section className="grid gap-6 rounded-3xl bg-transparent lg:grid-cols-2">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Material controls</h3>
        {disableForm && (
          <p className="mt-1 text-xs text-slate-400">
            Sketch at least one element to unlock targeted edits.
          </p>
        )}
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase text-slate-500">Object</label>
            <select
              {...register('elementId')}
              disabled={disableForm}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none disabled:cursor-not-allowed"
            >
              <option value="">Select layout object</option>
              {elements.map((element) => (
                <option key={element.id} value={element.id}>
                  {element.label}
                </option>
              ))}
            </select>
            {errors.elementId && (
              <p className="mt-1 text-xs text-rose-500">{errors.elementId.message}</p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500">
                Accent color
              </label>
              <input
                type="color"
                {...register('color')}
                className="mt-1 h-12 w-full cursor-pointer rounded-2xl border border-slate-200 bg-white"
                disabled={disableForm}
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500">
                Material direction
              </label>
              <textarea
                {...register('description')}
                rows={3}
                placeholder="Example: ribbed walnut paneling with brushed brass inlay"
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none disabled:cursor-not-allowed"
                disabled={disableForm}
              />
              {errors.description && (
                <p className="mt-1 text-xs text-rose-500">{errors.description.message}</p>
              )}
            </div>
          </div>
          <button
            type="submit"
            disabled={disableForm || mutation.isPending}
            className="w-full rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mutation.isPending ? 'Applying edit...' : 'Send to Nano Banana'}
          </button>
        </form>

        <div className="mt-6">
          <p className="text-xs font-semibold uppercase text-slate-500">Layout objects</p>
          <div className="mt-2 space-y-2">
            {elements.length === 0 && (
              <p className="text-sm text-slate-400">No objects captured from the canvas yet.</p>
            )}
            {elements.map((element) => (
              <div
                key={element.id}
                className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-2 text-sm"
              >
                <span className="font-medium text-slate-700">{element.label}</span>
                <span
                  className="h-5 w-5 rounded-full border border-slate-200"
                  style={{ background: element.fill }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">Edit history</h3>
          <span className="text-xs text-slate-400">{materialEdits.length} edits</span>
        </div>
        <div className="mt-4 space-y-3">
          {materialEdits.length === 0 && (
            <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
              Send a material prompt to track results here.
            </p>
          )}
          {materialEdits.map((edit) => (
            <div
              key={edit.id}
              className="rounded-2xl border border-slate-100 p-4 shadow-[0_1px_3px_rgba(15,23,42,0.05)]"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-800">
                    {elements.find((el) => el.id === edit.targetElementId)?.label ?? 'Selected area'}
                  </p>
                  <p className="text-xs text-slate-500">{formatDate(edit.createdAt)}</p>
                  <p className="mt-1 text-xs text-slate-500">{edit.description}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span
                    className={clsx(
                      'rounded-full px-3 py-1 text-xs font-semibold',
                      edit.status === 'complete'
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-amber-50 text-amber-600',
                    )}
                  >
                    {edit.status === 'complete' ? 'Ready' : 'Applying'}
                  </span>
                  <span
                    className="block h-6 w-6 rounded-full border border-slate-200"
                    style={{ background: edit.color }}
                  />
                </div>
              </div>
              {edit.previewUrl && (
                <div className="mt-3 overflow-hidden rounded-2xl border border-slate-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={edit.previewUrl}
                    alt="Material preview"
                    className="h-40 w-full object-cover"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

type SettingsDrawerProps = {
  open: boolean;
  onClose: () => void;
  apiKeys: ApiKeys;
  setApiKey: (key: keyof ApiKeys, value: string) => void;
};

function SettingsDrawer({ open, onClose, apiKeys, setApiKey }: SettingsDrawerProps) {
  const { register, handleSubmit, reset } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      nanoBanana: apiKeys.nanoBanana ?? '',
      assetStorage: apiKeys.assetStorage ?? '',
    },
  });

  useEffect(() => {
    reset({
      nanoBanana: apiKeys.nanoBanana ?? '',
      assetStorage: apiKeys.assetStorage ?? '',
    });
  }, [apiKeys, reset]);

  const onSubmit = (values: SettingsForm) => {
    if (values.nanoBanana !== undefined) {
      setApiKey('nanoBanana', values.nanoBanana);
    }
    if (values.assetStorage !== undefined) {
      setApiKey('assetStorage', values.assetStorage);
    }
    onClose();
  };

  return (
    <div
      className={clsx(
        'fixed inset-0 z-40 transition',
        open ? 'pointer-events-auto' : 'pointer-events-none',
      )}
    >
      <div
        className={clsx(
          'absolute inset-0 bg-slate-900/30 transition-opacity',
          open ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <div
        className={clsx(
          'absolute inset-y-0 right-0 w-full max-w-sm bg-white p-6 shadow-xl transition-transform duration-300',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Integrations</p>
            <h3 className="text-2xl font-semibold text-slate-900">API settings</h3>
            <p className="text-xs text-slate-500">
              Store keys locally to avoid retyping each session.
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-slate-500">
            Close
          </button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase text-slate-500">
              Nano Banana API key
            </label>
            <input
              {...register('nanoBanana')}
              placeholder="nbn_live_***"
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-semibold uppercase text-slate-500">
              Asset storage API key
            </label>
            <input
              {...register('assetStorage')}
              placeholder="s3_xxx or supabase key"
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white hover:bg-indigo-600"
          >
            Save settings
          </button>
        </form>
      </div>
    </div>
  );
}

type LayoutStageProps = {
  layoutName: string;
  ceilingHeight: number;
  layoutNotes: string;
  elements: LayoutElement[];
  onSaveMeta: (values: LayoutMetaForm) => void;
  onElementsChange: (elements: LayoutElement[]) => void;
  wallThicknessMm: number;
  onWallThicknessChange: (value: number) => void;
};

type DraftState =
  | { mode: 'polyline'; points: Point[] }
  | { mode: 'rectangle'; start: Point }
  | { mode: 'arc'; points: Point[] }
  | null;

function LayoutStage({
  layoutName,
  ceilingHeight,
  layoutNotes,
  elements,
  onSaveMeta,
  onElementsChange,
  wallThicknessMm,
  onWallThicknessChange,
}: LayoutStageProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const backdropUrlRef = useRef<string | null>(null);
  const [stageSize, setStageSize] = useState({ width: 960, height: 540 });
  const [draft, setDraft] = useState<DraftState>(null);
  const [activeWallTool, setActiveWallTool] = useState<WallToolId>('polyline');
  const [backdropName, setBackdropName] = useState<string | null>(null);
  const [backdropSrc, setBackdropSrc] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [backgroundImage] = useImage(backdropSrc ?? '');
  const thicknessPx = useMemo(() => mmToPx(wallThicknessMm), [wallThicknessMm]);
  const isDrawing = Boolean(draft);

  const cancelDrawing = useCallback(() => {
    setDraft(null);
    setPointer(null);
  }, []);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = entry.contentRect.width;
      setStageSize({
        width,
        height: Math.max(420, Math.round(width * 0.6)),
      });
    });
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (backdropUrlRef.current) {
        URL.revokeObjectURL(backdropUrlRef.current);
      }
    },
    [],
  );

  const commitWallElement = useCallback(
    (geometry: WallGeometry, rawPoints: Point[]) => {
      if (rawPoints.length === 0) return;
      const bounds = boundsFromPoints(rawPoints);
      const wallIndex = elements.filter((element) => element.type === 'wall').length + 1;
      const next: LayoutElement = {
        id: generateId(),
        type: 'wall',
        label: `Wall ${wallIndex}`,
        width: bounds.width,
        height: bounds.height,
        left: bounds.left,
        top: bounds.top,
        angle: 0,
        fill: defaultColor,
        geometry,
        thicknessMm: wallThicknessMm,
      };
      onElementsChange([...elements, next]);
    },
    [elements, onElementsChange, wallThicknessMm],
  );

  const finalizePolyline = useCallback(
    (points: Point[]) => {
      if (points.length < 2) return;
      commitWallElement({ kind: 'polyline', points: flattenPoints(points) }, points);
    },
    [commitWallElement],
  );

  const finalizeRectangle = useCallback(
    (start: Point, end: Point) => {
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);
      if (width < 2 || height < 2) return;
      const corners = [
        { x: start.x, y: start.y },
        { x: end.x, y: start.y },
        { x: end.x, y: end.y },
        { x: start.x, y: end.y },
      ];
      commitWallElement({ kind: 'rectangle', points: flattenPoints(corners) }, corners);
    },
    [commitWallElement],
  );

  const finalizeArc = useCallback(
    (points: Point[]) => {
      if (points.length !== 3) return;
      const [start, control, end] = points;
      commitWallElement(
        { kind: 'arc', points: [start.x, start.y, control.x, control.y, end.x, end.y] },
        points,
      );
    },
    [commitWallElement],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelDrawing();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Return') && draft?.mode === 'polyline') {
        finalizePolyline(draft.points);
        setDraft(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [draft, cancelDrawing, finalizePolyline]);

  const handleMouseMove = useCallback((event: KonvaEventObject<MouseEvent>) => {
    const stage = event.target.getStage();
    if (!stage) return;
    const position = stage.getPointerPosition();
    if (!position) {
      setPointer(null);
      return;
    }
    setPointer({ x: position.x, y: position.y });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setPointer(null);
  }, []);

  const handleStageMouseDown = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      if (!stage || event.target !== stage) return;
      const pointerPosition = stage.getPointerPosition();
      if (!pointerPosition) return;
      const point = { x: pointerPosition.x, y: pointerPosition.y };

      if (activeWallTool === 'polyline') {
        if (!draft || draft.mode !== 'polyline') {
          setDraft({ mode: 'polyline', points: [point] });
        } else {
          setDraft({ mode: 'polyline', points: [...draft.points, point] });
        }
        return;
      }

      if (activeWallTool === 'rectangle') {
        if (!draft || draft.mode !== 'rectangle') {
          setDraft({ mode: 'rectangle', start: point });
        } else {
          finalizeRectangle(draft.start, point);
          setDraft(null);
        }
        return;
      }

      if (activeWallTool === 'arc') {
        if (!draft || draft.mode !== 'arc') {
          setDraft({ mode: 'arc', points: [point] });
        } else if (draft.points.length === 1) {
          setDraft({ mode: 'arc', points: [...draft.points, point] });
        } else {
          finalizeArc([...draft.points, point]);
          setDraft(null);
        }
      }
    },
    [activeWallTool, draft, finalizeArc, finalizeRectangle],
  );

  const handleDoubleClick = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      if (!stage || event.target !== stage) return;
      if (draft?.mode === 'polyline') {
        finalizePolyline(draft.points);
        setDraft(null);
      }
    },
    [draft, finalizePolyline],
  );

  const handleBackdrop = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      cancelDrawing();
      const url = URL.createObjectURL(file);
      if (backdropUrlRef.current) {
        URL.revokeObjectURL(backdropUrlRef.current);
      }
      backdropUrlRef.current = url;
      setBackdropSrc(url);
      setBackdropName(file.name);
    },
    [cancelDrawing],
  );

  const clearCanvas = useCallback(() => {
    cancelDrawing();
    onElementsChange([]);
    setBackdropName(null);
    if (backdropUrlRef.current) {
      URL.revokeObjectURL(backdropUrlRef.current);
      backdropUrlRef.current = null;
    }
    setBackdropSrc(null);
  }, [cancelDrawing, onElementsChange]);

  const formValues = useMemo(
    () => ({
      layoutName,
      ceilingHeight,
      layoutNotes: layoutNotes ?? '',
    }),
    [layoutName, ceilingHeight, layoutNotes],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LayoutMetaForm>({
    resolver: zodResolver(layoutMetaSchema),
    values: formValues,
  });

  const onSubmit = (values: LayoutMetaForm) => {
    onSaveMeta(values);
  };

  const selectWallTool = (tool: WallToolId) => {
    if (tool === activeWallTool) return;
    cancelDrawing();
    setActiveWallTool(tool);
  };

  const addOpeningElement = useCallback(
    (type: Exclude<LayoutElementType, 'wall'>) => {
      cancelDrawing();
      const { label, fill, width, height } = palette[type];
      const count = elements.filter((element) => element.type === type).length + 1;
      const jitterX = (Math.random() - 0.5) * 40;
      const jitterY = (Math.random() - 0.5) * 40;
      const x = stageSize.width / 2 - width / 2 + jitterX;
      const y = stageSize.height / 2 - height / 2 + jitterY;
      const geometry: OpeningGeometry = { kind: 'opening', width, height, x, y };
      const next: LayoutElement = {
        id: generateId(),
        type,
        label: `${label} ${count}`,
        width,
        height,
        left: x,
        top: y,
        angle: 0,
        fill,
        geometry,
      };
      onElementsChange([...elements, next]);
    },
    [cancelDrawing, elements, onElementsChange, stageSize.height, stageSize.width],
  );

  const handleOpeningDrag = useCallback(
    (elementId: string, x: number, y: number) => {
      onElementsChange(
        elements.map((element) =>
          element.id === elementId && element.geometry?.kind === 'opening'
            ? {
                ...element,
                left: x,
                top: y,
                geometry: { ...element.geometry, x, y },
              }
            : element,
        ),
      );
    },
    [elements, onElementsChange],
  );

  const describeElement = useCallback(
    (element: LayoutElement) => {
      if (!element.geometry) {
        return `${Math.round(element.width)}x${Math.round(element.height)} px`;
      }
      if (element.geometry.kind === 'opening') {
        return `${Math.round(element.geometry.width)}x${Math.round(
          element.geometry.height,
        )} px | drag to reposition`;
      }
      if (element.geometry.kind === 'polyline') {
        const segments = Math.max(1, element.geometry.points.length / 2 - 1);
        return `${segments} segment${segments > 1 ? 's' : ''} | ${
          element.thicknessMm ?? wallThicknessMm
        } mm`;
      }
      if (element.geometry.kind === 'rectangle') {
        return `${Math.round(element.width)}x${Math.round(element.height)} px | ${
          element.thicknessMm ?? wallThicknessMm
        } mm`;
      }
      if (element.geometry.kind === 'arc') {
        return `Arc | ${element.thicknessMm ?? wallThicknessMm} mm`;
      }
      return `${Math.round(element.width)}x${Math.round(element.height)} px`;
    },
    [wallThicknessMm],
  );

  const wallShapes = elements.map((element) => {
    const geometry = element.geometry;
    if (!geometry || geometry.kind === 'opening') return null;
    const color = element.fill ?? defaultColor;
    const strokeWidth = mmToPx(element.thicknessMm ?? wallThicknessMm);
    if (geometry.kind === 'polyline') {
      return (
        <Line
          key={element.id}
          points={geometry.points}
          stroke={color}
          strokeWidth={strokeWidth}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      );
    }
    if (geometry.kind === 'rectangle') {
      return (
        <Line
          key={element.id}
          points={geometry.points}
          closed
          stroke={color}
          strokeWidth={1}
          fill={color}
          opacity={0.85}
          listening={false}
        />
      );
    }
    return (
      <Line
        key={element.id}
        points={geometry.points}
        bezier
        stroke={color}
        strokeWidth={strokeWidth}
        lineCap="round"
        lineJoin="round"
        listening={false}
      />
    );
  });

  const openingShapes = elements.map((element) => {
    if (element.geometry?.kind !== 'opening') return null;
    const stroke = element.type === 'door' ? '#f97316' : '#3c6ff0';
    return (
      <Rect
        key={element.id}
        x={element.geometry.x}
        y={element.geometry.y}
        width={element.geometry.width}
        height={element.geometry.height}
        fill={element.fill}
        opacity={element.type === 'door' ? 0.9 : 0.75}
        stroke={stroke}
        strokeWidth={2}
        cornerRadius={element.type === 'door' ? 8 : 4}
        draggable
        onDragEnd={(event) => handleOpeningDrag(element.id, event.target.x(), event.target.y())}
      />
    );
  });

  const draftShape = (() => {
    if (!draft) return null;
    if (draft.mode === 'polyline') {
      const staticPoints = flattenPoints(draft.points);
      const previewPoints = pointer ? [...staticPoints, pointer.x, pointer.y] : staticPoints;
      return (
        <Line
          points={previewPoints}
          stroke={defaultColor}
          strokeWidth={thicknessPx}
          lineCap="round"
          lineJoin="round"
          dash={[8, 4]}
          listening={false}
        />
      );
    }
    if (draft.mode === 'rectangle' && pointer) {
      const corners = [
        { x: draft.start.x, y: draft.start.y },
        { x: pointer.x, y: draft.start.y },
        { x: pointer.x, y: pointer.y },
        { x: draft.start.x, y: pointer.y },
      ];
      return (
        <Line
          points={flattenPoints(corners)}
          closed
          stroke={defaultColor}
          strokeWidth={2}
          fill="rgba(15,23,42,0.08)"
          dash={[6, 4]}
          listening={false}
        />
      );
    }
    if (draft.mode === 'arc') {
      const [start, control] = draft.points;
      if (!start) return null;
      const previewControl = control ?? pointer ?? start;
      const previewEnd = pointer ?? control ?? start;
      return (
        <Line
          points={[
            start.x,
            start.y,
            previewControl.x,
            previewControl.y,
            previewEnd.x,
            previewEnd.y,
          ]}
          bezier
          stroke={defaultColor}
          strokeWidth={thicknessPx}
          dash={[8, 4]}
          lineCap="round"
          lineJoin="round"
          listening={false}
        />
      );
    }
    return null;
  })();

  return (
    <section className="flex flex-col gap-6 rounded-3xl bg-transparent">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Studio canvas</p>
            <h2 className="text-xl font-semibold text-slate-900">Draw the enclosure</h2>
          </div>
          <div className="flex gap-2">
            <input
              type="file"
              accept="image/*"
              onChange={handleBackdrop}
              className="hidden"
              id="layout-upload"
            />
            <label
              htmlFor="layout-upload"
              className="cursor-pointer rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:border-slate-300"
            >
              Upload plan
            </label>
            <button
              type="button"
              onClick={clearCanvas}
              className="rounded-full border border-transparent bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200"
            >
              Clear canvas
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase text-slate-500">Wall tools</p>
            <div className="mt-2 flex flex-wrap gap-3">
              {wallTools.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  onClick={() => selectWallTool(id)}
                  className={clsx(
                    'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition',
                    activeWallTool === id
                      ? 'border-[var(--accent)] bg-white text-[var(--accent)] shadow-sm'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                  )}
                >
                  <Icon active={activeWallTool === id} />
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Polyline: click to add points, double-click or press Enter to finish. Rectangle: two
              clicks. Arc: three clicks (start, control, end). ESC or switching tools cancels the
              current shape.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {(['door', 'window'] as const).map((type) => (
                <button
                  type="button"
                  key={type}
                  onClick={() => {
                    addOpeningElement(type);
                  }}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:border-slate-300"
                >
                  {type === 'door' ? <DoorIcon /> : <WindowIcon />}
                  Add {type}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-4">
            <p className="text-xs font-semibold uppercase text-slate-500">Canvas info</p>
            <div className="mt-2 space-y-1 text-sm text-slate-500">
              <p>
                Active tool:{' '}
                <span className="font-semibold text-slate-700">
                  {wallTools.find((tool) => tool.id === activeWallTool)?.label ?? activeWallTool}
                </span>
              </p>
              <p className="text-xs text-slate-400">
                Click on empty canvas areas to sketch. Elements are stored immediately.
              </p>
              {backdropName && (
                <p>
                  Background: <span className="font-semibold text-slate-700">{backdropName}</span>
                </p>
              )}
              <p>
                Elements: <span className="font-semibold text-slate-700">{elements.length}</span>
              </p>
              <div className="mt-3 space-y-1">
                <label className="text-xs font-semibold uppercase text-slate-500">
                  Wall thickness (mm)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={50}
                    max={1000}
                    step={10}
                    value={wallThicknessMm}
                    onChange={(event) =>
                      onWallThicknessChange(
                        Math.min(
                          1000,
                          Math.max(
                            10,
                            (() => {
                              const mmValue = Number(event.target.value);
                              return Number.isNaN(mmValue) ? defaultWallThicknessMm : mmValue;
                            })(),
                          ),
                        ),
                      )
                    }
                    className="w-28 rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
                  />
                  <span className="text-xs text-slate-400">~ {Math.round(thicknessPx)} px</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          ref={wrapperRef}
          className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-inner"
        >
          <Stage
            width={stageSize.width}
            height={stageSize.height}
            className="block w-full rounded-2xl bg-white"
            style={{ cursor: isDrawing ? 'crosshair' : 'cell' }}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onDblClick={handleDoubleClick}
          >
            <Layer>
              <Rect
                x={0}
                y={0}
                width={stageSize.width}
                height={stageSize.height}
                fill="#ffffff"
                listening={false}
              />
              {backgroundImage && (
                <KonvaImage
                  image={backgroundImage}
                  x={0}
                  y={0}
                  width={stageSize.width}
                  height={stageSize.height}
                  opacity={0.35}
                  listening={false}
                />
              )}
              {wallShapes}
              {openingShapes}
              {draftShape}
            </Layer>
          </Stage>
        </div>
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Room metadata</h3>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Layout name
            </label>
            <input
              {...register('layoutName')}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              placeholder="Penthouse living/dining"
            />
            {errors.layoutName && (
              <p className="mt-1 text-xs text-rose-500">{errors.layoutName.message}</p>
            )}
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Ceiling height (m)
            </label>
            <input
              type="number"
              step="0.1"
              {...register('ceilingHeight', { valueAsNumber: true })}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
            {errors.ceilingHeight && (
              <p className="mt-1 text-xs text-rose-500">{errors.ceilingHeight.message}</p>
            )}
          </div>
          <div>
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Notes
            </label>
            <textarea
              {...register('layoutNotes')}
              rows={3}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              placeholder="Key openings, orientation, measurements..."
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-600"
          >
            Save metadata
          </button>
        </form>
        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Active elements
          </p>
          <div className="mt-2 space-y-2">
            {elements.length === 0 && (
              <p className="text-sm text-slate-400">Sketch walls, doors or windows to populate.</p>
            )}
            {elements.map((element) => (
              <div
                key={element.id}
                className="flex items-center justify-between rounded-2xl border border-slate-100 px-3 py-2 text-sm"
              >
                <span className="font-semibold text-slate-700">{element.label}</span>
                <span className="text-xs text-slate-400">{describeElement(element)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

type RenderStageProps = {
  layoutName: string;
  furniture: FurnitureSample[];
  setFurniture: Dispatch<SetStateAction<FurnitureSample[]>>;
  prompt: string;
  setPrompt: (value: string) => void;
  stylePreset: string;
  setStylePreset: (value: string) => void;
  renderJobs: RenderJob[];
  addRenderJob: (job: RenderJob) => void;
  updateRenderJob: (jobId: string, patch: Partial<RenderJob>) => void;
};

function RenderStage({
  layoutName,
  furniture,
  setFurniture,
  prompt,
  setPrompt,
  stylePreset,
  setStylePreset,
  renderJobs,
  addRenderJob,
  updateRenderJob,
}: RenderStageProps) {

  const [uploading, setUploading] = useState(false);
  const styleLookup = useMemo(() => {
    const map: Record<string, string> = {};
    styles.forEach((styleOption) => {
      map[styleOption.id] = styleOption.label;
    });
    return map;
  }, []);
  const renderFormValues = useMemo(
    () => ({
      prompt,
      stylePreset,
      cameraHeight: 1.4,
    }),
    [prompt, stylePreset],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RenderForm>({
    resolver: zodResolver(renderSchema),
    values: renderFormValues,
  });

  const mutation = useMutation({
    mutationFn: simulateRenderRequest,
    onSuccess: ({ jobId, imageUrl }) => {
      updateRenderJob(jobId, { status: 'complete', imageUrl });
    },
  });

  const onSubmit = (values: RenderForm) => {
    setPrompt(values.prompt);
    setStylePreset(values.stylePreset);
    const jobId = generateId();
    addRenderJob({
      id: jobId,
      prompt: values.prompt,
      stylePreset: values.stylePreset,
      status: 'processing',
      createdAt: timestamp(),
    });
    mutation.mutate({ prompt: values.prompt, stylePreset: values.stylePreset, layoutName, jobId });
  };

  const handleFurnitureUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    setUploading(true);
    const list = Array.from(files).map((file) => ({
      id: generateId(),
      name: file.name,
      size: file.size,
      previewUrl: URL.createObjectURL(file),
    }));
    setFurniture((prev) => [...list, ...prev]);
    setTimeout(() => {
      setUploading(false);
    }, 500);
  };

  return (
    <section className="grid gap-6 rounded-3xl bg-transparent lg:grid-cols-2">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Render brief</h3>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-4">
          <div>
            <label className="text-xs font-semibold uppercase text-slate-500">
              Prompt
            </label>
            <textarea
              {...register('prompt')}
              rows={6}
              className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:border-[var(--accent)] focus:outline-none"
              placeholder="Describe mood, materials, lighting, hero pieces..."
            />
            {errors.prompt && (
              <p className="mt-1 text-xs text-rose-500">{errors.prompt.message}</p>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500">
                Style preset
              </label>
              <select
                {...register('stylePreset')}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              >
                {styles.map((styleOption) => (
                  <option key={styleOption.id} value={styleOption.id}>
                    {styleOption.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-slate-500">
                Camera height (m)
              </label>
              <input
                type="number"
                step="0.1"
                {...register('cameraHeight', { valueAsNumber: true })}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              />
              {errors.cameraHeight && (
                <p className="mt-1 text-xs text-rose-500">{errors.cameraHeight.message}</p>
              )}
            </div>
          </div>
          <button
            type="submit"
            className="w-full rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white hover:bg-indigo-600 disabled:opacity-60"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Requesting Nano Banana render...' : 'Request render'}
          </button>
        </form>
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Reference assets</h3>
            <p className="text-xs text-slate-500">
              Drop furniture, finishes, or moodboard snippets for context.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="furniture-upload"
              type="file"
              multiple
              className="hidden"
              accept="image/*"
              onChange={handleFurnitureUpload}
            />
            <label
              htmlFor="furniture-upload"
              className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-300"
            >
              Upload
            </label>
          </div>
        </div>

        {uploading && (
          <p className="mt-2 text-xs text-[var(--accent)]">Importing samples...</p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {furniture.length === 0 && (
            <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
              No furniture references yet.
            </p>
          )}
          {furniture.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-2xl border border-slate-100 px-3 py-2"
            >
              <div className="h-12 w-12 rounded-2xl bg-slate-100">
                {item.previewUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    className="h-12 w-12 rounded-2xl object-cover"
                  />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700">{item.name}</p>
                <p className="text-xs text-slate-400">
                  {(item.size / 1024 / 1024).toFixed(1)} MB
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Render queue</h3>
            <span className="text-xs text-slate-400">{renderJobs.length} requests</span>
          </div>
          <div className="mt-3 space-y-3">
            {renderJobs.length === 0 && (
              <p className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
                Submit a prompt to see Nano Banana renders here.
              </p>
            )}
            {renderJobs.map((job) => (
              <div
                key={job.id}
                className="rounded-2xl border border-slate-100 p-4 shadow-[0_1px_3px_rgba(15,23,42,0.05)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      {styleLookup[job.stylePreset] ?? 'Custom preset'}
                    </p>
                    <p className="text-xs text-slate-500">{formatDate(job.createdAt)}</p>
                    <p className="mt-1 text-xs text-slate-500">{job.prompt}</p>
                  </div>
                  <span
                    className={clsx(
                      'rounded-full px-3 py-1 text-xs font-semibold',
                      job.status === 'complete'
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-amber-50 text-amber-600',
                    )}
                  >
                    {job.status === 'complete' ? 'Ready' : 'Processing'}
                  </span>
                </div>
                {job.imageUrl && (
                  <div className="mt-3 overflow-hidden rounded-2xl border border-slate-100">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={job.imageUrl}
                      alt="Render preview"
                      className="h-48 w-full object-cover"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

