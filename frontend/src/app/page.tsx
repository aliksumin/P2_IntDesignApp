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
import { Stage, Layer, Line, Rect, Image as KonvaImage, Group, Arc } from 'react-konva';
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
} from '@/types/layout';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Line as KonvaLine } from 'konva/lib/shapes/Line';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import type { Vector2d } from 'konva/lib/types';

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
const UNDO_HISTORY_LIMIT = 50;
const OPENING_SNAP_DISTANCE = 40;
const WALL_SNAP_THRESHOLD = 16;
const CANVAS_MIN_SCALE = 0.3;
const CANVAS_MAX_SCALE = 4;
const CANVAS_SCALE_STEP = 1.08;
type Point = { x: number; y: number };

const flattenPoints = (points: Point[]) =>
  points.flatMap((pt) => [Number(pt.x.toFixed(2)), Number(pt.y.toFixed(2))]);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const extendOpenPath = (
  points: Point[],
  extension: number,
  options: { extendStart?: boolean; extendEnd?: boolean } = {},
) => {
  if (extension <= 0 || points.length < 2) {
    return points;
  }
  const isClosed = distanceBetween(points[0], points[points.length - 1]) < 0.5;
  if (isClosed) {
    return points;
  }
  const { extendStart = true, extendEnd = true } = options;
  if (!extendStart && !extendEnd) {
    return points;
  }
  const cloned = points.map((pt) => ({ ...pt }));
  if (extendStart) {
    const dir = normalizeVector(cloned[1].x - cloned[0].x, cloned[1].y - cloned[0].y);
    cloned[0] = {
      x: cloned[0].x - dir.x * extension,
      y: cloned[0].y - dir.y * extension,
    };
  }
  if (extendEnd) {
    const lastIdx = cloned.length - 1;
    const dir = normalizeVector(
      cloned[lastIdx].x - cloned[lastIdx - 1].x,
      cloned[lastIdx].y - cloned[lastIdx - 1].y,
    );
    cloned[lastIdx] = {
      x: cloned[lastIdx].x + dir.x * extension,
      y: cloned[lastIdx].y + dir.y * extension,
    };
  }
  return cloned;
};

const getWorldPointerPosition = (stage: KonvaStage | null): Point | null => {
  if (!stage) return null;
  const pointer = stage.getPointerPosition() as Vector2d | null;
  if (!pointer) return null;
  const transform = stage.getAbsoluteTransform().copy();
  transform.invert();
  const pos = transform.point(pointer);
  return { x: pos.x, y: pos.y };
};

const normalizeVector = (dx: number, dy: number) => {
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
};

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
const pxToMm = (px: number) => Math.round(px * 10);

const sampleQuadraticPoints = (start: Point, control: Point, end: Point, segments = 24) => {
  const safeSegments = Math.max(2, segments);
  const result: Point[] = [];
  for (let i = 0; i <= safeSegments; i += 1) {
    const t = i / safeSegments;
    const oneMinusT = 1 - t;
    const x =
      oneMinusT * oneMinusT * start.x +
      2 * oneMinusT * t * control.x +
      t * t * end.x;
    const y =
      oneMinusT * oneMinusT * start.y +
      2 * oneMinusT * t * control.y +
      t * t * end.y;
    result.push({ x, y });
  }
  return result;
};

const toPointPairs = (values: number[]): Point[] => {
  const result: Point[] = [];
  for (let i = 0; i < values.length; i += 2) {
    result.push({ x: values[i], y: values[i + 1] });
  }
  return result;
};

const getWallPathPoints = (element: LayoutElement): Point[] => {
  const geometry = element.geometry;
  if (!geometry) return [];
  if (geometry.kind === 'polyline') {
    return toPointPairs(geometry.points);
  }
  if (geometry.kind === 'arc') {
    const [sx, sy, cx, cy, ex, ey] = geometry.points;
    return sampleQuadraticPoints({ x: sx, y: sy }, { x: cx, y: cy }, { x: ex, y: ey }, 48);
  }
  if (geometry.kind === 'rectangle') {
    return toPointPairs(geometry.points);
  }
  return [];
};

const distanceBetween = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

const closestPointOnSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  const closest = { x: start.x + t * dx, y: start.y + t * dy };
  const distance = Math.hypot(point.x - closest.x, point.y - closest.y);
  const angle = Math.atan2(dy, dx);
  return { closest, distance, angle, t };
};

const splitPathAtLength = (points: Point[], target: number) => {
  if (points.length === 0) {
    return { prefix: [], remainder: [] as Point[] };
  }
  if (target <= 0) {
    return { prefix: [points[0]], remainder: [...points] };
  }
  const prefix: Point[] = [points[0]];
  let remaining = target;
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const segLen = distanceBetween(start, end);
    if (segLen === 0) {
      continue;
    }
    if (remaining < segLen) {
      const ratio = remaining / segLen;
      const newPoint = {
        x: start.x + ratio * (end.x - start.x),
        y: start.y + ratio * (end.y - start.y),
      };
      prefix.push(newPoint);
      return {
        prefix,
        remainder: [newPoint, ...points.slice(i + 1)],
      };
    }
    if (remaining === segLen) {
      prefix.push(end);
      return {
        prefix,
        remainder: [...points.slice(i + 1)],
      };
    }
    remaining -= segLen;
    prefix.push(end);
  }
  return { prefix: [...points], remainder: [points[points.length - 1]] };
};

const normalizePath = (points: Point[]) => {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const prev = result[result.length - 1];
    if (!prev || prev.x !== current.x || prev.y !== current.y) {
      result.push(current);
    }
  }
  return result;
};

const getPathLength = (points: Point[]) => {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    total += distanceBetween(points[i], points[i + 1]);
  }
  return total;
};

const extractPathSection = (points: Point[], start: number, end: number) => {
  if (end <= start) return [];
  const { remainder } = splitPathAtLength(points, start);
  const { prefix } = splitPathAtLength(remainder, end - start);
  return prefix;
};

type SnapResult = {
  point: Point;
  angle: number;
  wallId: string;
  pathPoints: Point[];
  pathLength: number;
  distanceAlongPath: number;
};

const findSnapPointOnWalls = (point: Point, walls: LayoutElement[]): SnapResult | null => {
  let best: SnapResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  walls.forEach((wall) => {
    const path = getWallPathPoints(wall);
    if (path.length < 2) return;
    let cumulative = 0;
    let totalLength = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      totalLength += distanceBetween(path[i], path[i + 1]);
    }
    for (let i = 0; i < path.length - 1; i += 1) {
      const segmentLength = distanceBetween(path[i], path[i + 1]);
      if (segmentLength === 0) continue;
      const { closest, distance, angle, t } = closestPointOnSegment(point, path[i], path[i + 1]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          point: closest,
          angle: (angle * 180) / Math.PI,
          wallId: wall.id,
          pathPoints: path,
          pathLength: totalLength,
          distanceAlongPath: cumulative + t * segmentLength,
        };
      }
      cumulative += segmentLength;
    }
  });
  if (!best || bestDistance > OPENING_SNAP_DISTANCE) {
    return null;
  }
  return best;
};

const subtractIntervalsFromPath = (points: Point[], intervals: { start: number; end: number }[]) => {
  if (intervals.length === 0) {
    return [normalizePath(points)];
  }
  const totalLength = getPathLength(points);
  if (totalLength === 0) return [];
  const normalizedIntervals = intervals
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(start, totalLength)),
      end: Math.max(0, Math.min(end, totalLength)),
    }))
    .filter(({ end, start }) => end > start)
    .sort((a, b) => a.start - b.start);
  const segments: Point[][] = [];
  let cursor = 0;
  normalizedIntervals.forEach(({ start, end }) => {
    if (start > cursor) {
      const segment = extractPathSection(points, cursor, start);
      if (segment.length >= 2) {
        segments.push(normalizePath(segment));
      }
    }
    cursor = Math.max(cursor, end);
  });
  if (cursor < totalLength) {
    const finalSegment = extractPathSection(points, cursor, totalLength);
    if (finalSegment.length >= 2) {
      segments.push(normalizePath(finalSegment));
    }
  }
  return segments;
};

const getElementBounds = (element: LayoutElement) => ({
  x: element.left ?? 0,
  y: element.top ?? 0,
  width: Math.max(1, element.width ?? 0),
  height: Math.max(1, element.height ?? 0),
});

const rectsIntersect = (
  rectA: { x: number; y: number; width: number; height: number },
  rectB: { x: number; y: number; width: number; height: number },
) => {
  return !(
    rectA.x + rectA.width < rectB.x ||
    rectB.x + rectB.width < rectA.x ||
    rectA.y + rectA.height < rectB.y ||
    rectB.y + rectB.height < rectA.y
  );
};

const normalizeRect = (start: Point, current: Point) => ({
  x: Math.min(start.x, current.x),
  y: Math.min(start.y, current.y),
  width: Math.abs(start.x - current.x),
  height: Math.abs(start.y - current.y),
});

const getOpeningCenter = (element: LayoutElement) => ({
  x: element.left + element.width / 2,
  y: element.top + element.height / 2,
});

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

type PendingOpening =
  | {
      type: Exclude<LayoutElementType, 'wall'>;
      width: number;
      height: number;
      label: string;
      infoHeightMm?: number;
    }
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
  const [interactionMode, setInteractionMode] = useState<'draw' | 'select'>('draw');
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [orthoMode, setOrthoMode] = useState(true);
  const [pendingOpening, setPendingOpening] = useState<PendingOpening>(null);
  const [pendingSnap, setPendingSnap] = useState<SnapResult | null>(null);
  const [defaultWallColor, setDefaultWallColor] = useState(defaultColor);
  const [defaultWallMaterial, setDefaultWallMaterial] = useState('Generic wall');
  const [marqueeRect, setMarqueeRect] = useState<{ start: Point; current: Point } | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [canvasPan, setCanvasPan] = useState({ x: 0, y: 0 });
  const [canvasScale, setCanvasScale] = useState(1);
  const panOriginRef = useRef<{ pointer: Point; offset: Point } | null>(null);
  const historyRef = useRef<LayoutElement[][]>([]);
  const [historySize, setHistorySize] = useState(0);
  const canUndo = historySize > 0;
  const [backgroundImage] = useImage(backdropSrc ?? '');
  const thicknessPx = useMemo(() => mmToPx(wallThicknessMm), [wallThicknessMm]);
  const isDrawing = Boolean(draft);

  const cancelDrawing = useCallback(() => {
    setDraft(null);
    setPointer(null);
    setPendingSnap(null);
  }, []);

  const cancelPendingOpening = useCallback(() => {
    setPendingOpening(null);
    setPendingSnap(null);
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

  const applyOrthoPoint = useCallback(
    (point: Point, anchor?: Point) => {
      if (!orthoMode || !anchor) {
        return point;
      }
      const dx = point.x - anchor.x;
      const dy = point.y - anchor.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: point.x, y: anchor.y };
      }
      return { x: anchor.x, y: point.y };
    },
    [orthoMode],
  );

  const applyElementsChange = useCallback(
    (
      producer: (current: LayoutElement[]) => LayoutElement[] | null,
      options?: { preserveSelectionId?: string | null },
    ): boolean => {
      const next = producer(elements);
      if (!next || next === elements) {
        return false;
      }
      historyRef.current.push(elements);
      if (historyRef.current.length > UNDO_HISTORY_LIMIT) {
        historyRef.current.shift();
      }
      setHistorySize(historyRef.current.length);
      onElementsChange(next);
      if (options?.preserveSelectionId) {
        const id = options.preserveSelectionId;
        setSelectedElementId(next.some((element) => element.id === id) ? id : null);
      } else {
        setSelectedElementId(null);
      }
      return true;
    },
    [elements, onElementsChange],
  );

  const undoLast = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setHistorySize(historyRef.current.length);
    setSelectedElementId(null);
    onElementsChange(previous);
  }, [onElementsChange]);

  const deleteSelected = useCallback(() => {
    if (!selectedElementId) return;
    applyElementsChange((current) => {
      if (!current.some((element) => element.id === selectedElementId)) {
        return null;
      }
      return current.filter((element) => element.id !== selectedElementId);
    });
  }, [applyElementsChange, selectedElementId]);

  const commitOpeningSnap = useCallback(
    (opening: PendingOpening | null, snap: SnapResult, existing?: LayoutElement) => {
          const openingWidth = opening?.width ?? existing?.width ?? 0;
          const openingHeight = opening?.height ?? existing?.height ?? 0;
      const openingHeightMm =
        (opening && opening.infoHeightMm) ??
        existing?.geometry?.heightMm ??
        pxToMm(openingHeight);
      if (!openingWidth || !openingHeight) return false;
      if (!elements.some((element) => element.id === snap.wallId)) return false;
      const elementType = opening?.type ?? existing?.type ?? 'door';
      const labelBase =
        opening?.label ??
        (existing?.label ? existing.label.replace(/\s+\d+$/, '') : elementType === 'door' ? 'Door' : 'Window');
      const { point, angle } = snap;
      const left = point.x - openingWidth / 2;
      const top = point.y - openingHeight / 2;
      return applyElementsChange((current) => {
        if (!current.some((element) => element.id === snap.wallId)) {
          return null;
        }
        if (existing) {
          const idx = current.findIndex((element) => element.id === existing.id);
          if (idx === -1) return null;
          const updated = [...current];
          updated[idx] = {
            ...existing,
            left,
            top,
            angle,
            geometry: {
              kind: 'opening',
              width: openingWidth,
              height: openingHeight,
              x: left,
              y: top,
              angle,
              wallId: snap.wallId,
              distanceAlongPath: snap.distanceAlongPath,
              wallPathLength: snap.pathLength,
              heightMm: openingHeightMm,
            },
          };
          return updated;
        }
        const count = current.filter((element) => element.type === elementType).length + 1;
          const openingElement: LayoutElement = {
            id: generateId(),
            type: elementType,
            label: `${labelBase} ${count}`,
            width: openingWidth,
            height: openingHeight,
          left,
          top,
          angle,
          fill: palette[elementType].fill,
          geometry: {
            kind: 'opening',
            width: openingWidth,
            height: openingHeight,
            x: left,
            y: top,
            angle,
            wallId: snap.wallId,
              distanceAlongPath: snap.distanceAlongPath,
              wallPathLength: snap.pathLength,
              heightMm: openingHeightMm,
            },
          };
        return [...current, openingElement];
      });
    },
    [applyElementsChange, elements],
  );

  const stageCursor = isPanning
    ? 'grabbing'
    : pendingOpening
    ? pendingSnap
      ? 'crosshair'
      : 'not-allowed'
    : interactionMode === 'select'
      ? 'pointer'
      : isDrawing
        ? 'crosshair'
        : 'cell';
  const selectedElement = useMemo(
    () => elements.find((element) => element.id === selectedElementId) ?? null,
    [elements, selectedElementId],
  );
  const wallElements = useMemo(
    () => elements.filter((element) => element.type === 'wall' && element.geometry),
    [elements],
  );
  const wallSnapRefs = useMemo(
    () =>
      wallElements.flatMap((wall) => {
        const path = getWallPathPoints(wall);
        if (path.length < 2) return [];
        return [
          { wallId: wall.id, point: path[0] },
          { wallId: wall.id, point: path[path.length - 1] },
        ];
      }),
    [wallElements],
  );
  const wallSnapPoints = useMemo(
    () => wallSnapRefs.map((ref) => ref.point),
    [wallSnapRefs],
  );
  const getSnappedPoint = useCallback(
    (point: Point, anchor?: Point, extraPoints: Point[] = []) => {
      const basePoint = anchor ? applyOrthoPoint(point, anchor) : point;
      const candidates = wallSnapPoints.concat(extraPoints);
      let closest = basePoint;
      let bestDistance = WALL_SNAP_THRESHOLD;
      candidates.forEach((candidate) => {
        const dist = distanceBetween(basePoint, candidate);
        if (dist < bestDistance) {
          bestDistance = dist;
          closest = candidate;
        }
      });
      return closest;
    },
    [applyOrthoPoint, wallSnapPoints],
  );
  const elementLabels = useMemo(() => {
    const map = new Map<string, string>();
    elements.forEach((element) => {
      map.set(element.id, element.label);
    });
    return map;
  }, [elements]);
  const openingsByWall = useMemo(() => {
    const map = new Map<string, { start: number; end: number }[]>();
    elements.forEach((element) => {
      if (element.geometry?.kind !== 'opening') return;
      if (typeof element.geometry.distanceAlongPath !== 'number') return;
      const width = element.width;
      const wallId = element.geometry.wallId;
      if (!wallId) return;
      const start = Math.max(0, element.geometry.distanceAlongPath - width / 2);
      const end = element.geometry.distanceAlongPath + width / 2;
      const list = map.get(wallId) ?? [];
      list.push({ start, end });
      map.set(wallId, list);
    });
    map.forEach((intervals, wallId) => {
      intervals.sort((a, b) => a.start - b.start);
      map.set(wallId, intervals);
    });
    return map;
  }, [elements]);
  const canDelete = Boolean(selectedElementId);

  const handleShapeSelect = useCallback(
    (elementId: string, event?: KonvaEventObject<MouseEvent>) => {
      if (interactionMode !== 'select') return;
      event?.cancelBubble?.();
      setSelectedElementId(elementId);
    },
    [interactionMode],
  );

  const finalizePendingOpening = useCallback(() => {
    if (!pendingOpening || !pendingSnap) return false;
    const success = commitOpeningSnap(pendingOpening, pendingSnap, undefined);
    if (success) {
      setPendingOpening(null);
      setPendingSnap(null);
    }
    return success;
  }, [commitOpeningSnap, pendingOpening, pendingSnap]);

  useEffect(
    () => () => {
      if (backdropUrlRef.current) {
        URL.revokeObjectURL(backdropUrlRef.current);
      }
    },
    [],
  );

  const commitWallElements = useCallback(
    (entries: { geometry: WallGeometry; rawPoints: Point[] }[]) => {
      const validEntries = entries.filter((entry) => entry.rawPoints.length >= 2);
      if (validEntries.length === 0) return;
      applyElementsChange((current) => {
        const existingWalls = current.filter((element) => element.type === 'wall').length;
        const additions = validEntries.map(({ geometry, rawPoints }, idx) => {
          const bounds = boundsFromPoints(rawPoints);
          return {
            id: generateId(),
            type: 'wall' as const,
            label: `Wall ${existingWalls + idx + 1}`,
            width: bounds.width,
            height: bounds.height,
            left: bounds.left,
            top: bounds.top,
            angle: 0,
            fill: defaultWallColor,
            materialName: defaultWallMaterial,
            geometry,
            thicknessMm: wallThicknessMm,
          };
        });
        return [...current, ...additions];
      });
    },
    [applyElementsChange, defaultWallColor, defaultWallMaterial, wallThicknessMm],
  );

  const finalizePolyline = useCallback(
    (points: Point[]) => {
      if (points.length < 2) return;
      commitWallElements([
        { geometry: { kind: 'polyline', points: flattenPoints(points) }, rawPoints: points },
      ]);
    },
    [commitWallElements],
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
      const segments: [Point, Point][] = [
        [corners[0], corners[1]],
        [corners[1], corners[2]],
        [corners[2], corners[3]],
        [corners[3], corners[0]],
      ];
      commitWallElements(
        segments.map(([a, b]) => ({
          geometry: { kind: 'polyline', points: flattenPoints([a, b]) },
          rawPoints: [a, b],
        })),
      );
    },
    [commitWallElements],
  );

  const finalizeArc = useCallback(
    (points: Point[]) => {
      if (points.length !== 3) return;
      const [start, control, end] = points;
      const sampled = sampleQuadraticPoints(start, control, end);
      commitWallElements([
        {
          geometry: { kind: 'arc', points: [start.x, start.y, control.x, control.y, end.x, end.y] },
          rawPoints: sampled,
        },
      ]);
    },
    [commitWallElements],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pendingOpening) {
          cancelPendingOpening();
          return;
        }
        if (draft?.mode === 'polyline' && draft.points.length > 1) {
          setDraft({ mode: 'polyline', points: draft.points.slice(0, -1) });
          return;
        }
        cancelDrawing();
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Return') && draft?.mode === 'polyline') {
        finalizePolyline(draft.points);
        setDraft(null);
      }
      if (event.key === 'Delete' && selectedElementId) {
        event.preventDefault();
        deleteSelected();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undoLast();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [
    draft,
    cancelDrawing,
    cancelPendingOpening,
    pendingOpening,
    finalizePolyline,
    deleteSelected,
    selectedElementId,
    undoLast,
  ]);

  const handleMouseMove = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      if (!stage) return;
      const worldPoint = getWorldPointerPosition(stage);
      const screenPointer = stage.getPointerPosition();
      if (!worldPoint || !screenPointer) {
        setPointer(null);
        setPendingSnap(null);
        setMarqueeRect(null);
        if (isPanning) {
          setIsPanning(false);
          panOriginRef.current = null;
        }
        return;
      }
      if (isPanning && panOriginRef.current) {
        const { pointer, offset } = panOriginRef.current;
        setCanvasPan({
          x: offset.x + screenPointer.x - pointer.x,
          y: offset.y + screenPointer.y - pointer.y,
        });
        return;
      }
      setPointer(worldPoint);
      if (marqueeRect) {
        setMarqueeRect((prev) => (prev ? { ...prev, current: worldPoint } : prev));
        return;
      }
      if (pendingOpening) {
        setPendingSnap(findSnapPointOnWalls(worldPoint, wallElements));
      }
    },
    [isPanning, marqueeRect, pendingOpening, wallElements],
  );

  const handleMouseLeave = useCallback(() => {
    setPointer(null);
    setPendingSnap(null);
    setMarqueeRect(null);
    setIsPanning(false);
    panOriginRef.current = null;
  }, []);

  const handleStageMouseDown = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      if (!stage) return;
      if (event.evt && event.evt.button === 1) {
        event.evt.preventDefault();
        const pointerPosition = stage.getPointerPosition();
        if (!pointerPosition) return;
        panOriginRef.current = { pointer: pointerPosition, offset: canvasPan };
        setIsPanning(true);
        return;
      }
      if (pendingOpening) {
        if (pendingSnap) {
          void finalizePendingOpening();
        }
        return;
      }
      if (interactionMode === 'select') {
        if (event.target === stage) {
          const pointerPosition = getWorldPointerPosition(stage);
          if (!pointerPosition) return;
          setMarqueeRect({ start: pointerPosition, current: pointerPosition });
        }
        return;
      }
      if (event.target !== stage) return;
      const pointerPosition = getWorldPointerPosition(stage);
      if (!pointerPosition) return;
      const point = { x: pointerPosition.x, y: pointerPosition.y };

      if (activeWallTool === 'polyline') {
        const anchor =
          draft && draft.mode === 'polyline' ? draft.points[draft.points.length - 1] : undefined;
        const extra =
          draft && draft.mode === 'polyline' && draft.points.length > 0 ? [draft.points[0]] : [];
        const snappedPoint = getSnappedPoint(point, anchor, extra);
        if (!draft || draft.mode !== 'polyline') {
          setDraft({ mode: 'polyline', points: [snappedPoint] });
        } else {
          setDraft({ mode: 'polyline', points: [...draft.points, snappedPoint] });
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
    [
      activeWallTool,
      canvasPan,
      draft,
      finalizeArc,
      finalizePendingOpening,
      finalizeRectangle,
      getSnappedPoint,
      interactionMode,
      panOriginRef,
      pendingOpening,
      pendingSnap,
    ],
  );

  const handleStageMouseUp = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      if (isPanning) {
        setIsPanning(false);
        panOriginRef.current = null;
        return;
      }
      if (interactionMode !== 'select') {
        setMarqueeRect(null);
        return;
      }
      const stage = event.target.getStage();
      if (!stage) return;
      if (marqueeRect) {
        const rect = normalizeRect(marqueeRect.start, marqueeRect.current);
        setMarqueeRect(null);
        if (rect.width < 3 && rect.height < 3) {
          if (event.target === stage) {
            setSelectedElementId(null);
          }
          return;
        }
        const hits = elements.filter((element) =>
          rectsIntersect(rect, getElementBounds(element)),
        );
        const chosen = hits.length ? hits[hits.length - 1] : null;
        setSelectedElementId(chosen?.id ?? null);
        return;
      }
      if (event.target === stage) {
        setSelectedElementId(null);
      }
    },
    [elements, interactionMode, isPanning, marqueeRect],
  );

  const handleStageWheel = useCallback(
    (event: KonvaEventObject<WheelEvent>) => {
      event.evt.preventDefault();
      const stage = event.target.getStage();
      if (!stage) return;
      const screenPointer = stage.getPointerPosition();
      const worldPointer = getWorldPointerPosition(stage);
      if (!screenPointer || !worldPointer) return;
      const direction = event.evt.deltaY > 0 ? -1 : 1;
      const scaleMultiplier = direction > 0 ? CANVAS_SCALE_STEP : 1 / CANVAS_SCALE_STEP;
      const nextScale = clamp(canvasScale * scaleMultiplier, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE);
      if (nextScale === canvasScale) return;
      setCanvasScale(nextScale);
      setCanvasPan({
        x: screenPointer.x - worldPointer.x * nextScale,
        y: screenPointer.y - worldPointer.y * nextScale,
      });
    },
    [canvasScale],
  );

  const handleDoubleClick = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      if (!stage || event.target !== stage || interactionMode !== 'draw' || pendingOpening) return;
      if (draft?.mode === 'polyline') {
        finalizePolyline(draft.points);
        setDraft(null);
      }
    },
    [draft, finalizePolyline, interactionMode, pendingOpening],
  );

  const handleBackdrop = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      cancelDrawing();
      cancelPendingOpening();
      const url = URL.createObjectURL(file);
      if (backdropUrlRef.current) {
        URL.revokeObjectURL(backdropUrlRef.current);
      }
      backdropUrlRef.current = url;
      setBackdropSrc(url);
      setBackdropName(file.name);
    },
    [cancelDrawing, cancelPendingOpening],
  );

  const clearCanvas = useCallback(() => {
    cancelDrawing();
    cancelPendingOpening();
    applyElementsChange((current) => (current.length === 0 ? null : []));
    setBackdropName(null);
    if (backdropUrlRef.current) {
      URL.revokeObjectURL(backdropUrlRef.current);
      backdropUrlRef.current = null;
    }
    setBackdropSrc(null);
  }, [applyElementsChange, cancelDrawing, cancelPendingOpening]);

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
    if (tool === activeWallTool && interactionMode === 'draw') return;
    cancelDrawing();
    cancelPendingOpening();
    setInteractionMode('draw');
    setActiveWallTool(tool);
  };

  const addOpeningElement = useCallback(
    (type: Exclude<LayoutElementType, 'wall'>) => {
      cancelDrawing();
      cancelPendingOpening();
      const walls = wallElements;
      if (walls.length === 0) {
        console.warn('Draw walls before placing doors or windows.');
        return;
      }
      const desiredCenter = { x: stageSize.width / 2, y: stageSize.height / 2 };
      const snap = findSnapPointOnWalls(desiredCenter, walls);
      if (!snap) {
        console.info('Move the cursor near a wall to place the opening.');
      }
      const { width, height, label } = palette[type];
      setPendingOpening({
        type,
        width,
        height,
        label,
        infoHeightMm: pxToMm(height),
      });
      setPendingSnap(snap ?? null);
    },
    [cancelDrawing, cancelPendingOpening, stageSize.height, stageSize.width, wallElements],
  );

  const handleOpeningDrag = useCallback(
    (element: LayoutElement, position: Point, revert: () => void) => {
      if (element.geometry?.kind !== 'opening') {
        revert();
        return false;
      }
      const snap = findSnapPointOnWalls(position, wallElements);
      if (!snap) {
        revert();
        return false;
      }
      const updated = commitOpeningSnap(null, snap, element);
      if (!updated) {
        revert();
        return false;
      }
      return true;
    },
    [commitOpeningSnap, wallElements],
  );

  const updateSelectedElement = useCallback(
    (updater: (current: LayoutElement) => LayoutElement | null) => {
      if (!selectedElementId) return false;
      return applyElementsChange(
        (current) => {
          const index = current.findIndex((element) => element.id === selectedElementId);
          if (index === -1) return null;
          const updated = updater(current[index]);
          if (!updated) return null;
          const next = [...current];
          next[index] = updated;
          return next;
        },
        { preserveSelectionId: selectedElementId },
      );
    },
    [applyElementsChange, selectedElementId],
  );

  const applyWallTranslation = useCallback(
    (wallId: string, dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return false;
      return applyElementsChange(
        (current) => {
          const index = current.findIndex((element) => element.id === wallId);
          if (index === -1) return null;
          const wall = current[index];
          if (!wall.geometry || wall.geometry.kind === 'opening') return null;
          const pathPoints = getWallPathPoints(wall);
          if (pathPoints.length < 2) return null;
          let translated = pathPoints.map((point) => ({
            x: point.x + dx,
            y: point.y + dy,
          }));
          const otherRefs = wallSnapRefs.filter((ref) => ref.wallId !== wallId);
          if (otherRefs.length > 0) {
            const endpoints = [translated[0], translated[translated.length - 1]];
            let adjustX = 0;
            let adjustY = 0;
            let best = WALL_SNAP_THRESHOLD;
            otherRefs.forEach(({ point }) => {
              endpoints.forEach((endpoint) => {
                const dist = distanceBetween(endpoint, point);
                if (dist < best) {
                  best = dist;
                  adjustX = point.x - endpoint.x;
                  adjustY = point.y - endpoint.y;
                }
              });
            });
            if (best < WALL_SNAP_THRESHOLD) {
              translated = translated.map((pt) => ({
                x: pt.x + adjustX,
                y: pt.y + adjustY,
              }));
            }
          }
          const bounds = boundsFromPoints(translated);
          const updated: LayoutElement = {
            ...wall,
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            geometry: {
              kind: 'polyline',
              points: flattenPoints(translated),
            },
          };
          const copy = [...current];
          copy[index] = updated;
          return copy;
        },
        { preserveSelectionId: wallId },
      );
    },
    [applyElementsChange, wallSnapRefs],
  );

  const describeElement = useCallback(
    (element: LayoutElement) => {
      if (!element.geometry) {
        return `${pxToMm(element.width)}x${pxToMm(element.height)} mm`;
      }
      if (element.geometry.kind === 'opening') {
        const host =
          (element.geometry.wallId && elementLabels.get(element.geometry.wallId)) || 'wall';
        const heightMm =
          element.geometry.heightMm ?? pxToMm(element.geometry.height);
        return `${pxToMm(element.geometry.width)}x${heightMm} mm | ${host}`;
      }
      if (element.geometry.kind === 'polyline') {
        const segments = Math.max(1, element.geometry.points.length / 2 - 1);
        return `${segments} segment${segments > 1 ? 's' : ''} | ${
          element.thicknessMm ?? wallThicknessMm
        } mm${element.materialName ? ` | ${element.materialName}` : ''}`;
      }
      if (element.geometry.kind === 'rectangle') {
        return `${pxToMm(element.width)}x${pxToMm(element.height)} mm | ${
          element.thicknessMm ?? wallThicknessMm
        } mm${element.materialName ? ` | ${element.materialName}` : ''}`;
      }
      if (element.geometry.kind === 'arc') {
        return `Arc | ${element.thicknessMm ?? wallThicknessMm} mm${
          element.materialName ? ` | ${element.materialName}` : ''
        }`;
      }
      return `${pxToMm(element.width)}x${pxToMm(element.height)} mm`;
    },
    [elementLabels, wallThicknessMm],
  );

  const wallShapes = elements.flatMap((element) => {
    if (element.type !== 'wall' || !element.geometry || element.geometry.kind === 'opening') {
      return [];
    }
    const pathPoints = getWallPathPoints(element);
    if (pathPoints.length < 2) return [];
    const fillColor = element.fill ?? '#5b5b63';
    const isSelected = element.id === selectedElementId;
    const strokeWidth = mmToPx(element.thicknessMm ?? wallThicknessMm);
    const listening = interactionMode === 'select';
    const selectionHandler = listening
      ? (evt: KonvaEventObject<MouseEvent>) => handleShapeSelect(element.id, evt)
      : undefined;
    const cutouts = openingsByWall.get(element.id) ?? [];
    const segments = subtractIntervalsFromPath(pathPoints, cutouts);
    if (segments.length === 0) {
      return [];
    }
    const isClosedPath =
      pathPoints.length > 2 && distanceBetween(pathPoints[0], pathPoints[pathPoints.length - 1]) < 0.5;
    return segments.flatMap((segment, idx) => {
      const extensionAmount = (strokeWidth + 4) / 2;
      const touchesStart = !isClosedPath && distanceBetween(segment[0], pathPoints[0]) < 0.5;
      const touchesEnd =
        !isClosedPath && distanceBetween(segment[segment.length - 1], pathPoints[pathPoints.length - 1]) < 0.5;
      const extendedSegment =
        touchesStart || touchesEnd
          ? extendOpenPath(segment, extensionAmount, { extendStart: touchesStart, extendEnd: touchesEnd })
          : segment;
      const flattenedPoints = flattenPoints(extendedSegment);
      const baseKey = `${element.id}-${idx}`;
      const commonProps = {
        points: flattenedPoints,
        listening,
        draggable: listening,
        onMouseDown: selectionHandler,
        onDragStart: (evt: KonvaEventObject<MouseEvent>) => {
          if (!listening) {
            evt.target.stopDrag();
            return;
          }
          setSelectedElementId(element.id);
        },
        onDragEnd: (evt: KonvaEventObject<MouseEvent>) => {
          const node = evt.target as KonvaLine;
          const dx = node.x();
          const dy = node.y();
          node.position({ x: 0, y: 0 });
          void applyWallTranslation(element.id, dx, dy);
        },
        lineCap: 'butt' as const,
        lineJoin: 'miter' as const,
      };
      return [
        <Line
          key={`${baseKey}-outline`}
          {...commonProps}
          stroke="#000000"
          strokeWidth={strokeWidth + 4}
          shadowColor={isSelected ? '#4f46e5' : undefined}
          shadowBlur={isSelected ? 6 : 0}
          shadowOpacity={isSelected ? 0.9 : 0}
        />,
        <Line
          key={`${baseKey}-fill`}
          {...commonProps}
          stroke={fillColor}
          strokeWidth={strokeWidth}
        />,
      ];
    });
  });

  const openingShapes = elements.map((element) => {
    if (element.geometry?.kind !== 'opening') return null;
    const isSelected = element.id === selectedElementId;
    const listening = interactionMode === 'select';
    const rotation = element.geometry.angle ?? element.angle ?? 0;
    const rotationRad = (rotation * Math.PI) / 180;
    const dir = { x: Math.cos(rotationRad), y: Math.sin(rotationRad) };
    const perp = { x: -dir.y, y: dir.x };
    const center = getOpeningCenter(element);

    if (element.type === 'door') {
      const width = element.width;
      const wallThicknessForDoor = Math.max(6, element.height);
      const leafThickness = Math.max(3, wallThicknessForDoor / 2);
      const halfLeaf = leafThickness / 2;
      const hinge = {
        x: center.x - dir.x * (width / 2),
        y: center.y - dir.y * (width / 2),
      };
      const hingeInner = {
        x: hinge.x - dir.x * halfLeaf,
        y: hinge.y - dir.y * halfLeaf,
      };
      const hingeOuter = {
        x: hinge.x + dir.x * halfLeaf,
        y: hinge.y + dir.y * halfLeaf,
      };
      const swingInner = {
        x: hingeInner.x + perp.x * width,
        y: hingeInner.y + perp.y * width,
      };
      const swingOuter = {
        x: hingeOuter.x + perp.x * width,
        y: hingeOuter.y + perp.y * width,
      };
      const dirAngleDeg = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
      const arcOuterRadius = Math.max(2, width);
      const arcInnerRadius = Math.max(0, arcOuterRadius - 1);
      const doorLeafPoints = flattenPoints([hingeInner, hingeOuter, swingOuter, swingInner]);
      return (
        <Group
          key={element.id}
          draggable={listening}
          listening={listening}
          onMouseDown={listening ? (evt) => handleShapeSelect(element.id, evt) : undefined}
          onDragStart={(evt) => {
            if (!listening) {
              evt.target.stopDrag();
              return;
            }
            setSelectedElementId(element.id);
          }}
          onDragEnd={(event) => {
            const node = event.target;
            const dx = node.x();
            const dy = node.y();
            const revert = () => node.position({ x: 0, y: 0 });
            const success = handleOpeningDrag(element, { x: center.x + dx, y: center.y + dy }, revert);
            if (success) {
              node.position({ x: 0, y: 0 });
            } else {
              revert();
            }
          }}
        >
          <Line
            points={doorLeafPoints}
            closed
            fill="#ffffff"
            stroke="#000"
            strokeWidth={1}
            lineJoin="miter"
            shadowColor={isSelected ? '#4f46e5' : undefined}
            shadowBlur={isSelected ? 6 : 0}
            shadowOpacity={isSelected ? 0.9 : 0}
          />
          <Arc
            x={hinge.x}
            y={hinge.y}
            angle={90}
            rotation={dirAngleDeg}
            innerRadius={arcInnerRadius}
            outerRadius={arcOuterRadius}
            stroke="#000"
            strokeWidth={1}
            shadowColor={isSelected ? '#4f46e5' : undefined}
            shadowBlur={isSelected ? 6 : 0}
            shadowOpacity={isSelected ? 0.9 : 0}
          />
        </Group>
      );
    }

    const width = element.width;
    const height = Math.max(6, element.height);
    return (
      <Group
        key={element.id}
        draggable={listening}
        listening={listening}
        onMouseDown={listening ? (evt) => handleShapeSelect(element.id, evt) : undefined}
        onDragStart={(evt) => {
          if (!listening) {
            evt.target.stopDrag();
            return;
          }
          setSelectedElementId(element.id);
        }}
        onDragEnd={(event) => {
          const node = event.target;
          const dx = node.x();
          const dy = node.y();
          const revert = () => node.position({ x: 0, y: 0 });
          const success = handleOpeningDrag(element, { x: center.x + dx, y: center.y + dy }, revert);
          if (success) {
            node.position({ x: 0, y: 0 });
          } else {
            revert();
          }
        }}
      >
        <Rect
          x={center.x}
          y={center.y}
          offsetX={width / 2}
          offsetY={height / 2}
          width={width}
          height={height}
          rotation={rotation}
          fill="#dce9f5"
          stroke="#000"
          strokeWidth={2}
        />
        <Rect
          x={center.x}
          y={center.y}
          offsetX={width / 2 - 3}
          offsetY={height / 2 - 2}
          width={Math.max(2, width - 6)}
          height={Math.max(2, height - 4)}
          rotation={rotation}
          stroke="#ffffff"
          strokeWidth={1}
        />
        <Line
          points={[
            center.x - dir.x * (width / 2),
            center.y - dir.y * (width / 2),
            center.x + dir.x * (width / 2),
            center.y + dir.y * (width / 2),
          ]}
          stroke={isSelected ? '#4f46e5' : '#000'}
          strokeWidth={1}
        />
      </Group>
    );
  });

  const ghostOpeningShape =
    pendingOpening && pendingSnap ? (
      <Rect
        x={pendingSnap.point.x}
        y={pendingSnap.point.y}
        offsetX={pendingOpening.width / 2}
        offsetY={pendingOpening.height / 2}
        width={pendingOpening.width}
        height={pendingOpening.height}
        rotation={pendingSnap.angle}
        cornerRadius={pendingOpening.type === 'door' ? 8 : 4}
        stroke="#6366f1"
        dash={[4, 4]}
        strokeWidth={2}
        fill="rgba(99,102,241,0.15)"
        listening={false}
      />
    ) : null;
  const marqueeOverlay =
    marqueeRect && interactionMode === 'select'
      ? (() => {
          const rect = normalizeRect(marqueeRect.start, marqueeRect.current);
          return (
            <Rect
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              stroke="#6366f1"
              dash={[4, 4]}
              strokeWidth={1}
              fill="rgba(99,102,241,0.08)"
              listening={false}
            />
          );
        })()
      : null;

  const showPropertiesPanel =
    interactionMode === 'draw' || Boolean(selectedElement) || Boolean(pendingOpening);

  const handleDefaultThicknessChange = (value: number) => {
    if (Number.isNaN(value)) return;
    const mmValue = Math.min(1000, Math.max(10, value));
    onWallThicknessChange(mmValue);
  };

  const handleWallThicknessUpdate = (value: number) => {
    if (Number.isNaN(value)) return;
    const mmValue = Math.min(1000, Math.max(10, value));
    updateSelectedElement((current) => ({
      ...current,
      thicknessMm: mmValue,
    }));
  };

  const handleWallColorUpdate = (value: string) => {
    updateSelectedElement((current) => ({
      ...current,
      fill: value,
    }));
  };

  const handleWallMaterialUpdate = (value: string) => {
    updateSelectedElement((current) => ({
      ...current,
      materialName: value,
    }));
  };

  const handleOpeningDimensionUpdate = (dimension: 'width' | 'height', valueMm: number) => {
    if (Number.isNaN(valueMm)) return;
    const normalizedMm = Math.max(20, valueMm);
    updateSelectedElement((current) => {
      if (current.geometry?.kind !== 'opening') return null;
      if (dimension === 'width') {
        const pxValue = normalizedMm / 10;
        const center = getOpeningCenter(current);
        return {
          ...current,
          width: pxValue,
          left: center.x - pxValue / 2,
          top: center.y - current.height / 2,
          geometry: {
            ...current.geometry,
            width: pxValue,
            x: center.x - pxValue / 2,
            y: center.y - current.height / 2,
          },
        };
      }
      // Height is informative only; store the mm value on geometry for display.
      return {
        ...current,
        geometry: {
          ...current.geometry,
          heightMm: normalizedMm,
        },
      };
    });
  };

  const propertiesPanelContent = (() => {
    if (pendingOpening) {
      return (
          <>
            <p className="text-xs font-semibold uppercase text-slate-500">
              {pendingOpening.type === 'door' ? 'Door' : 'Window'} placement
            </p>
            <p className="text-sm text-slate-600">
            Move your cursor over a wall to preview snapping. Click to confirm, or press ESC to
            cancel.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <label className="text-xs font-semibold uppercase text-slate-500">
              Width (mm)
              <input
                type="number"
                min={20}
                value={pxToMm(pendingOpening.width)}
                onChange={(event) =>
                  setPendingOpening((prev) =>
                    prev
                      ? {
                          ...prev,
                          width: Math.max(20, Number(event.target.value) || 20) / 10,
                        }
                      : prev,
                  )
                }
                onFocus={(event) => event.target.select()}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
            <label className="text-xs font-semibold uppercase text-slate-500">
              Height (mm)
              <input
                type="number"
                min={20}
                value={pendingOpening.infoHeightMm ?? pxToMm(pendingOpening.height)}
                onChange={(event) =>
                  setPendingOpening((prev) =>
                    prev
                      ? {
                          ...prev,
                          infoHeightMm: Math.max(20, Number(event.target.value) || 20),
                        }
                      : prev,
                  )
                }
                onFocus={(event) => event.target.select()}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          </div>
          {!pendingSnap && (
            <p className="mt-2 text-xs text-amber-600">
              Hover over any wall to snap this opening into place.
            </p>
          )}
          <button
            type="button"
            onClick={cancelPendingOpening}
            className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-slate-400"
          >
            Cancel placement
          </button>
        </>
      );
    }
    if (selectedElement) {
      if (selectedElement.type === 'wall') {
        const wallThicknessValue = selectedElement.thicknessMm ?? wallThicknessMm;
        return (
          <>
            <p className="text-xs font-semibold uppercase text-slate-500">Wall properties</p>
            <p className="text-sm font-medium text-slate-800">{selectedElement.label}</p>
            <div className="space-y-3">
              <label className="block text-xs font-semibold uppercase text-slate-500">
                Thickness (mm)
                <input
                  type="number"
                  min={10}
                  max={1000}
                  step={10}
                  value={wallThicknessValue}
                  onChange={(event) => handleWallThicknessUpdate(Number(event.target.value))}
                  onFocus={(event) => event.target.select()}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
              <label className="block text-xs font-semibold uppercase text-slate-500">
                Color
                <input
                  type="color"
                  value={selectedElement.fill ?? defaultWallColor}
                  onChange={(event) => handleWallColorUpdate(event.target.value)}
                  className="mt-1 h-10 w-full cursor-pointer rounded-xl border border-slate-200 bg-white"
                />
              </label>
              <label className="block text-xs font-semibold uppercase text-slate-500">
                Material
                <input
                  type="text"
                  value={selectedElement.materialName ?? ''}
                  onChange={(event) => handleWallMaterialUpdate(event.target.value)}
                  placeholder="e.g., Gypsum board"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
            </div>
          </>
        );
      }
      if (selectedElement.type === 'door' || selectedElement.type === 'window') {
        return (
          <>
            <p className="text-xs font-semibold uppercase text-slate-500">
              {selectedElement.type === 'door' ? 'Door' : 'Window'} properties
            </p>
            <p className="text-sm font-medium text-slate-800">{selectedElement.label}</p>
            <div className="space-y-3">
              <label className="block text-xs font-semibold uppercase text-slate-500">
                Width (mm)
                <input
                  type="number"
                  min={20}
                  value={pxToMm(selectedElement.width)}
                  onChange={(event) =>
                    handleOpeningDimensionUpdate('width', Number(event.target.value))
                  }
                  onFocus={(event) => event.target.select()}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
              <label className="block text-xs font-semibold uppercase text-slate-500">
                Height (mm)
                <input
                  type="number"
                  min={20}
                  value={
                    selectedElement.geometry?.kind === 'opening'
                      ? selectedElement.geometry.heightMm ?? pxToMm(selectedElement.height)
                      : pxToMm(selectedElement.height)
                  }
                  onChange={(event) =>
                    handleOpeningDimensionUpdate('height', Number(event.target.value))
                  }
                  onFocus={(event) => event.target.select()}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
              {selectedElement.geometry?.kind === 'opening' && selectedElement.geometry.wallId && (
                <p className="text-xs text-slate-500">
                  Host wall:{' '}
                  <span className="font-semibold">
                    {elementLabels.get(selectedElement.geometry.wallId) ?? 'Wall'}
                  </span>
                </p>
              )}
            </div>
          </>
        );
      }
    }
    return (
      <>
        <p className="text-xs font-semibold uppercase text-slate-500">Wall defaults</p>
        <div className="space-y-3 text-sm">
          <label className="block text-xs font-semibold uppercase text-slate-500">
            Thickness (mm)
            <input
              type="number"
              min={10}
              max={1000}
              step={10}
              value={wallThicknessMm}
              onChange={(event) => handleDefaultThicknessChange(Number(event.target.value))}
              onFocus={(event) => event.target.select()}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              ≈ {Math.round(thicknessPx)} px stroke
            </span>
          </label>
          <label className="block text-xs font-semibold uppercase text-slate-500">
            Color
            <input
              type="color"
              value={defaultWallColor}
              onChange={(event) => setDefaultWallColor(event.target.value)}
              className="mt-1 h-10 w-full cursor-pointer rounded-xl border border-slate-200 bg-white"
            />
          </label>
          <label className="block text-xs font-semibold uppercase text-slate-500">
            Material
            <input
              type="text"
              value={defaultWallMaterial}
              onChange={(event) => setDefaultWallMaterial(event.target.value)}
              placeholder="e.g., Lime plaster"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1 text-sm focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
          {pendingOpening && (
            <button
              type="button"
              onClick={cancelPendingOpening}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:border-slate-400"
            >
              Cancel door/window placement
            </button>
          )}
        </div>
      </>
    );
  })();

  const propertiesPanel = showPropertiesPanel ? (
    <div className="pointer-events-auto absolute right-4 top-4 w-72 max-w-[calc(100%-2rem)] rounded-2xl border border-white/60 bg-white/70 p-4 text-sm text-slate-700 shadow-xl backdrop-blur">
      {propertiesPanelContent}
    </div>
  ) : null;

  const draftShape = (() => {
    if (!draft) return null;
    if (draft.mode === 'polyline') {
      const staticPoints = flattenPoints(draft.points);
      const anchor = draft.points[draft.points.length - 1];
      const extra = draft.points.length ? [draft.points[0]] : [];
      const previewTarget =
        pointer && anchor ? getSnappedPoint(pointer, anchor, extra) : pointer;
      const previewPoints = previewTarget
        ? [...staticPoints, previewTarget.x, previewTarget.y]
        : staticPoints;
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
      const looped = [...corners, corners[0]];
      return (
        <Line
          points={flattenPoints(looped)}
          stroke={defaultColor}
          strokeWidth={thicknessPx}
          lineCap="round"
          lineJoin="round"
          dash={[6, 6]}
          listening={false}
        />
      );
    }
    if (draft.mode === 'arc') {
      const [start, control] = draft.points;
      if (!start) return null;
      const previewControl = control ?? pointer ?? start;
      const previewEnd = pointer ?? control ?? start;
      const previewPoints = sampleQuadraticPoints(start, previewControl, previewEnd);
      return (
        <Line
          points={flattenPoints(previewPoints)}
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
          <div className="space-y-4">
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
                clicks. Arc: three clicks (start, control, end). ESC cancels the active tool.
                Selecting Door/Window spawns a preview that follows your cursor—click any wall
                (including arcs) to snap and cut the opening with ortho-enabled wall segments.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {(['door', 'window'] as const).map((type) => (
                  <button
                    type="button"
                    key={type}
                    disabled={Boolean(pendingOpening)}
                    onClick={() => {
                      setInteractionMode('draw');
                      addOpeningElement(type);
                    }}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {type === 'door' ? <DoorIcon /> : <WindowIcon />}
                    Add {type}
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase text-slate-500">Commands</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    cancelPendingOpening();
                    setInteractionMode('draw');
                  }}
                  className={clsx(
                    'rounded-xl border px-3 py-2 text-sm font-medium transition',
                    interactionMode === 'draw'
                      ? 'border-[var(--accent)] bg-white text-[var(--accent)] shadow-sm'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                  )}
                >
                  Draw mode
                </button>
                <button
                  type="button"
                  onClick={() => {
                    cancelDrawing();
                    cancelPendingOpening();
                    setInteractionMode('select');
                  }}
                  className={clsx(
                    'rounded-xl border px-3 py-2 text-sm font-medium transition',
                    interactionMode === 'select'
                      ? 'border-[var(--accent)] bg-white text-[var(--accent)] shadow-sm'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                  )}
                >
                  Select mode
                </button>
                <button
                  type="button"
                  onClick={undoLast}
                  disabled={!canUndo}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={deleteSelected}
                  disabled={!canDelete}
                  className="rounded-xl border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 transition hover:border-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setOrthoMode((value) => !value)}
                  className={clsx(
                    'rounded-xl border px-3 py-2 text-sm font-medium transition',
                    orthoMode
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-600'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300',
                  )}
                >
                  Ortho {orthoMode ? 'On' : 'Off'}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Select mode lets you pick, drag, or delete existing walls, doors, and windows.
                {pendingOpening && (
                  <>
                    {' '}
                    Door/window placement is active—move the cursor over a wall and click to confirm
                    or press ESC to cancel.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-4">
            <p className="text-xs font-semibold uppercase text-slate-500">Canvas info</p>
            <div className="mt-2 space-y-1 text-sm text-slate-500">
              <p>
                Mode:{' '}
                <span className="font-semibold text-slate-700">
                  {interactionMode === 'select' ? 'Select' : 'Draw'}
                </span>
              </p>
              <p>
                Selection:{' '}
                <span className="font-semibold text-slate-700">
                  {selectedElement ? selectedElement.label : 'None'}
                </span>
              </p>
              <p>
                Active tool:{' '}
                <span className="font-semibold text-slate-700">
                  {wallTools.find((tool) => tool.id === activeWallTool)?.label ?? activeWallTool}
                </span>
              </p>
              <p>
                Ortho snap:{' '}
                <span className="font-semibold text-slate-700">{orthoMode ? 'On' : 'Off'}</span>
              </p>
              <p className="text-xs text-slate-400">
                Click on empty canvas areas to sketch. Toggle Select mode to edit existing geometry.
              </p>
              {backdropName && (
                <p>
                  Background: <span className="font-semibold text-slate-700">{backdropName}</span>
                </p>
              )}
              <p>
                Elements: <span className="font-semibold text-slate-700">{elements.length}</span>
              </p>
            </div>
          </div>
        </div>

        <div
          ref={wrapperRef}
          className="relative mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-inner"
        >
          <Stage
            x={canvasPan.x}
            y={canvasPan.y}
            scaleX={canvasScale}
            scaleY={canvasScale}
            width={stageSize.width}
            height={stageSize.height}
            className="block w-full rounded-2xl bg-white"
            style={{ cursor: stageCursor }}
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            onDblClick={handleDoubleClick}
            onMouseUp={handleStageMouseUp}
            onWheel={handleStageWheel}
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
              {ghostOpeningShape}
              {marqueeOverlay}
              {draftShape}
            </Layer>
          </Stage>
          {propertiesPanel}
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
            {elements.map((element) => {
              const isSelected = element.id === selectedElementId;
              return (
                <button
                  type="button"
                  key={element.id}
                  onClick={() => {
                    cancelDrawing();
                    setInteractionMode('select');
                    setSelectedElementId(element.id);
                  }}
                  className={clsx(
                    'flex w-full items-center justify-between rounded-2xl border px-3 py-2 text-left text-sm transition',
                    isSelected
                      ? 'border-[var(--accent)] bg-indigo-50/70 text-[var(--accent)]'
                      : 'border-slate-100 text-slate-600 hover:border-slate-200',
                  )}
                >
                  <span className="font-semibold">{element.label}</span>
                  <span className="text-xs">{describeElement(element)}</span>
                </button>
              );
            })}
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

