'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import clsx from 'clsx';
import type { fabric } from 'fabric';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { simulateMaterialEdit, simulateRenderRequest } from '@/lib/mockApi';

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
type FabricStatic = typeof fabric;

type LayoutElementType = 'wall' | 'door' | 'window';

type LayoutElement = {
  id: string;
  type: LayoutElementType;
  label: string;
  width: number;
  height: number;
  left: number;
  top: number;
  angle: number;
  fill: string;
};

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

let fabricLoader: Promise<FabricStatic> | null = null;
const getFabric = () => {
  if (!fabricLoader) {
    fabricLoader = import('fabric').then((mod) => mod.fabric);
  }
  return fabricLoader;
};
type FabricMeta = {
  id?: string;
  type?: LayoutElementType;
  label?: string;
};
type FabricShape = fabric.Object & { data?: FabricMeta };

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

const palette: Record<
  LayoutElementType,
  { label: string; fill: string; width: number; height: number; opacity: number }
> = {
  wall: {
    label: 'Wall',
    fill: '#0f172a',
    width: 220,
    height: 26,
    opacity: 1,
  },
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
};

function LayoutStage({
  layoutName,
  ceilingHeight,
  layoutNotes,
  elements,
  onSaveMeta,
  onElementsChange,
}: LayoutStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const fabricLibRef = useRef<FabricStatic | null>(null);
  const bgUrl = useRef<string | null>(null);
  const [activeTool, setActiveTool] = useState<LayoutElementType>('wall');
  const [backdropName, setBackdropName] = useState<string | null>(null);
  const ensureFabric = async () => {
    if (fabricLibRef.current) {
      return fabricLibRef.current;
    }
    const lib = await getFabric();
    fabricLibRef.current = lib;
    return lib;
  };


  useEffect(() => {
    let disposed = false;

    const setupCanvas = async () => {
      const fabricLib = await getFabric();
      if (disposed || !canvasRef.current) return;
      fabricLibRef.current = fabricLib;
      const canvas = new fabricLib.Canvas(canvasRef.current, {
        selection: true,
        backgroundColor: '#f8fafc',
      });
      fabricRef.current = canvas;

      const persistElements = () => {
        const objs = canvas.getObjects();
        const data: LayoutElement[] = objs.map((obj, index) => {
          const fallbackId = `element-${index}`;
          const meta = (obj as FabricShape).data ?? {};
          return {
            id: meta.id ?? fallbackId,
            type: (meta.type as LayoutElementType) ?? 'wall',
            label: meta.label ?? `Element ${index + 1}`,
            width: obj.getScaledWidth?.() ?? obj.width ?? 0,
            height: obj.getScaledHeight?.() ?? obj.height ?? 0,
            left: obj.left ?? 0,
            top: obj.top ?? 0,
            angle: obj.angle ?? 0,
            fill: (obj.fill as string) ?? '#0f172a',
          };
        });
        onElementsChange(data);
      };

      canvas.on('object:added', persistElements);
      canvas.on('object:modified', persistElements);
      canvas.on('object:removed', persistElements);
    };

    setupCanvas();

    return () => {
      disposed = true;
      fabricRef.current?.dispose();
      fabricRef.current = null;
      if (bgUrl.current) {
        URL.revokeObjectURL(bgUrl.current);
        bgUrl.current = null;
      }
    };
  }, [onElementsChange]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const resize = () => {
      if (!wrapper || !canvasRef.current || !fabricRef.current) return;
      const width = wrapper.clientWidth;
      const height = Math.min(480, width * 0.65);
      canvasRef.current.width = width;
      canvasRef.current.height = height;
      fabricRef.current.setDimensions({ width, height });
      fabricRef.current.renderAll();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  const addElement = async (type: LayoutElementType) => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const fabricLib = await ensureFabric();
    const { fill, width, height, opacity, label } = palette[type];
    const id = generateId();
    const rect = new fabricLib.Rect({
      width,
      height,
      fill,
      opacity,
      left: canvas.getWidth() / 2 - width / 2 + Math.random() * 60,
      top: canvas.getHeight() / 2 - height / 2 + Math.random() * 40,
      rx: type === 'door' ? 8 : 4,
      ry: type === 'door' ? 8 : 4,
      hasRotatingPoint: true,
      cornerColor: '#3c6ff0',
      cornerStyle: 'circle',
      transparentCorners: false,
    }) as FabricShape;
    rect.data = {
      id,
      type,
      label: `${label} ${canvas.getObjects().length + 1}`,
    };
    canvas.add(rect);
    canvas.setActiveObject(rect);
  };

  const handleBackdrop = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !fabricRef.current) return;
    const url = URL.createObjectURL(file);
    if (bgUrl.current) {
      URL.revokeObjectURL(bgUrl.current);
    }
    bgUrl.current = url;
    void ensureFabric().then((fabricLib) => {
      fabricLib.Image.fromURL(url, (img) => {
        img.set({
          scaleX: fabricRef.current!.getWidth() / img.width!,
          scaleY: fabricRef.current!.getHeight() / img.height!,
          opacity: 0.35,
        });
        fabricRef.current!.setBackgroundImage(img, fabricRef.current!.renderAll.bind(fabricRef.current));
        setBackdropName(file.name);
      });
    });
  };

  const clearCanvas = () => {
    fabricRef.current?.clear();
    fabricRef.current?.setBackgroundColor('#f8fafc', fabricRef.current.renderAll.bind(fabricRef.current));
    onElementsChange([]);
    setBackdropName(null);
  };

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

  return (
    <section className="grid gap-6 rounded-3xl bg-transparent lg:grid-cols-2">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Studio canvas</p>
            <h2 className="text-xl font-semibold text-slate-900">Map your layout</h2>
          </div>
          <div className="flex gap-2">
            <input
              type="file"
              accept="image/*,application/pdf"
              onChange={handleBackdrop}
              className="hidden"
              id="layout-upload"
            />
            <label
              htmlFor="layout-upload"
              className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:border-slate-300"
            >
              Upload plan
            </label>
            <button
              onClick={clearCanvas}
              className="rounded-full border border-transparent bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-200"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          {(Object.keys(palette) as LayoutElementType[]).map((type) => (
            <button
              key={type}
              onClick={() => {
                setActiveTool(type);
                void addElement(type);
              }}
              className={clsx(
                'rounded-full px-4 py-2 text-sm font-medium capitalize',
                activeTool === type
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
              )}
            >
              Add {palette[type].label.toLowerCase()}
            </button>
          ))}
        </div>

        <div ref={wrapperRef} className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-2">
          <canvas ref={canvasRef} className="block w-full rounded-2xl bg-white" />
        </div>

        {backdropName && (
          <p className="mt-2 text-xs text-slate-500">
            Background: <span className="font-medium text-slate-600">{backdropName}</span>
          </p>
        )}
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
                <span className="font-medium text-slate-700">{element.label}</span>
                <span className="text-xs text-slate-400">
                  {Math.round(element.width)}x{Math.round(element.height)} px
                </span>
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
