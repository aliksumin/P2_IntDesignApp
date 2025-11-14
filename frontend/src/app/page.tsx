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
  type RefObject,
} from 'react';
import clsx from 'clsx';
import { Stage, Layer, Line, Rect, Image as KonvaImage, Group, Arc, Circle } from 'react-konva';
import useImage from 'use-image';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { simulateMaterialEdit } from '@/lib/mockApi';
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
    .max(600, 'Prompt should stay under 600 characters')
    .refine(
      (value) => {
        const trimmed = value.trim();
        return trimmed.length === 0 || trimmed.length >= 10;
      },
      { message: 'Enter at least 10 characters if you provide a prompt.' },
    ),
  aspectRatio: z.string(),
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
  aspectRatio?: string;
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

type LayoutInsight = {
  shape?: string;
  doors?: string;
  windows?: string;
};

type LayoutInsightStatus = 'idle' | 'loading' | 'needs-key' | 'error';

type LayoutNarrativeStatus = 'idle' | 'loading' | 'needs-key' | 'error';

type CollageDescriptionStatus = 'idle' | 'loading' | 'needs-key' | 'error';

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

const initialPrompt = '';
const defaultColor = '#111111';
const defaultWallThicknessMm = 200;
const UNDO_HISTORY_LIMIT = 50;
const OPENING_SNAP_DISTANCE = 40;
const WALL_SNAP_THRESHOLD = 16;
const WALL_CONNECTION_TOLERANCE = 12;
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

const buildSegmentPolygon = (start: Point, end: Point, width: number) => {
  const half = width / 2;
  const direction = normalizeVector(end.x - start.x, end.y - start.y);
  const perp = { x: -direction.y, y: direction.x };
  return [
    { x: start.x + perp.x * half, y: start.y + perp.y * half },
    { x: end.x + perp.x * half, y: end.y + perp.y * half },
    { x: end.x - perp.x * half, y: end.y - perp.y * half },
    { x: start.x - perp.x * half, y: start.y - perp.y * half },
  ];
};

type ConnectionPatchFragment = { wallId: string; points: [Point, Point]; color: string };
type ConnectionPatchEntry = { point: Point; fragments: ConnectionPatchFragment[] };
type OutlineEdge = { points: [Point, Point]; color: string };
const toKeyPoint = (point: Point) => `${point.x.toFixed(3)}:${point.y.toFixed(3)}`;
const formatConnectionKey = (point: Point) => toKeyPoint(point);
const edgeKey = (a: Point, b: Point) => {
  const aKey = toKeyPoint(a);
  const bKey = toKeyPoint(b);
  return aKey <= bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
};

const adjustWallEndpointGeometry = (
  element: LayoutElement,
  referencePoint: Point,
  delta: Point,
  tolerance: number,
): LayoutElement | null => {
  if (!element.geometry || element.geometry.kind === 'opening') return null;
  const path = getWallPathPoints(element);
  if (path.length < 2) return null;
  let changed = false;
  if (distanceBetween(path[0], referencePoint) <= tolerance) {
    path[0] = { x: path[0].x + delta.x, y: path[0].y + delta.y };
    changed = true;
  }
  const lastIndex = path.length - 1;
  if (distanceBetween(path[lastIndex], referencePoint) <= tolerance) {
    path[lastIndex] = { x: path[lastIndex].x + delta.x, y: path[lastIndex].y + delta.y };
    changed = true;
  }
  if (!changed) return null;
  const bounds = boundsFromPoints(path);
  return {
    ...element,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    geometry: {
      kind: 'polyline',
      points: flattenPoints(path),
    },
  };
};

const propagateWallConnections = (
  elements: LayoutElement[],
  movedIndex: number,
  originalEndpoints: [Point, Point],
  updatedEndpoints: [Point, Point],
): LayoutElement[] => {
  const adjustments = originalEndpoints
    .map((origin, idx) => {
      const target = updatedEndpoints[idx];
      return {
        origin,
        delta: { x: target.x - origin.x, y: target.y - origin.y },
      };
    })
    .filter(({ delta }) => Math.abs(delta.x) > 0.01 || Math.abs(delta.y) > 0.01);
  if (adjustments.length === 0) {
    return elements;
  }
  const next = [...elements];
  for (let i = 0; i < next.length; i += 1) {
    if (i === movedIndex) continue;
    const element = next[i];
    if (!element.geometry || element.geometry.kind === 'opening') continue;
    let updated = element;
    let changed = false;
    adjustments.forEach(({ origin, delta }) => {
      const candidate = adjustWallEndpointGeometry(updated, origin, delta, WALL_CONNECTION_TOLERANCE);
      if (candidate) {
        updated = candidate;
        changed = true;
      }
    });
    if (changed) {
      next[i] = updated;
    }
  }
  return next;
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

const getLayoutContentBounds = (elements: LayoutElement[]) => {
  if (elements.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  elements.forEach((element) => {
    const bounds = getElementBounds(element);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  });
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return null;
  }
  return {
    left: minX,
    top: minY,
    right: maxX,
    bottom: maxY,
  };
};

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error(`Failed to load collage image: ${src.slice(0, 60)}...`));
    image.src = src;
  });

const aspectRatioPresets = [
  { ratio: '1:1', width: 1024, height: 1024 },
  { ratio: '3:2', width: 1200, height: 800 },
  { ratio: '2:3', width: 800, height: 1200 },
  { ratio: '4:5', width: 1024, height: 1280 },
  { ratio: '5:4', width: 1280, height: 1024 },
  { ratio: '3:4', width: 864, height: 1152 },
  { ratio: '4:3', width: 1152, height: 864 },
  { ratio: '9:16', width: 828, height: 1472 },
  { ratio: '16:9', width: 1472, height: 828 },
  { ratio: '21:9', width: 1728, height: 744 },
];

const aspectRatioDimensions: Record<string, { width: number; height: number }> = Object.fromEntries(
  aspectRatioPresets.map((preset) => [preset.ratio, { width: preset.width, height: preset.height }]),
);

const aspectRatioOptions = aspectRatioPresets.map((preset) => preset.ratio);

const composeCollageDataUrl = async (items: FurnitureSample[]) => {
  if (typeof document === 'undefined') {
    return null;
  }
  const subset = items.slice(0, 6).filter((item) => Boolean(item.previewUrl));
  if (subset.length === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const columns = 3;
  const rows = 2;
  const tileWidth = canvas.width / columns;
  const tileHeight = canvas.height / rows;
  await Promise.all(
    subset.map(async (item, index) => {
      if (!item.previewUrl) return;
      const image = await loadImageElement(item.previewUrl);
      const col = index % columns;
      const row = Math.floor(index / columns);
      const cellX = col * tileWidth + 16;
      const cellY = row * tileHeight + 16;
      const cellWidth = tileWidth - 32;
      const cellHeight = tileHeight - 32;
      const ratio = Math.min(cellWidth / image.width, cellHeight / image.height);
      const drawWidth = image.width * ratio;
      const drawHeight = image.height * ratio;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cellX - 6, cellY - 6, cellWidth + 12, cellHeight + 12);
      ctx.drawImage(
        image,
        cellX + (cellWidth - drawWidth) / 2,
        cellY + (cellHeight - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
    }),
  );
  return canvas.toDataURL('image/png');
};

const dataUrlToBase64 = (value: string) => {
  const parts = value.split(',');
  return parts.length > 1 ? parts[1] : value;
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    return window.btoa(binary);
  }
  throw new Error('Base64 conversion is not supported in this environment.');
};

type FileDataPart = {
  fileUri?: string;
  mimeType?: string;
};

const downloadFileData = async (fileData: FileDataPart | undefined, apiKey: string) => {
  if (!fileData?.fileUri) return null;
  try {
    const url = new URL(fileData.fileUri);
    if (!url.searchParams.has('alt')) {
      url.searchParams.set('alt', 'media');
    }
    if (!url.searchParams.has('key')) {
      url.searchParams.set('key', apiKey);
    }
    const fileResponse = await fetch(url.toString());
    if (!fileResponse.ok) {
      console.warn('Failed to download Gemini file asset', fileResponse.status);
      return null;
    }
    const buffer = await fileResponse.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    return `data:${fileData.mimeType ?? 'image/png'};base64,${base64}`;
  } catch (error) {
    console.warn('Unable to resolve Gemini file asset', error);
    return null;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const tryParseJson = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const extractImageDataFromNode = async (
  node: unknown,
  apiKey: string,
  visited = new WeakSet<object>(),
): Promise<string | null> => {
  if (!node) return null;
  if (typeof node === 'string') {
    if (node.startsWith('data:image/')) return node;
    const parsed = tryParseJson(node);
    if (parsed) {
      return extractImageDataFromNode(parsed, apiKey, visited);
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const result = await extractImageDataFromNode(item, apiKey, visited);
      if (result) return result;
    }
    return null;
  }
  if (!isObject(node)) {
    return null;
  }
  if (visited.has(node)) return null;
  visited.add(node);

  const inlineData = node.inlineData as { data?: string; mimeType?: string } | undefined;
  if (inlineData?.data) {
    return `data:${inlineData.mimeType ?? 'image/png'};base64,${inlineData.data}`;
  }

  if ('fileData' in node) {
    const dataUrl = await downloadFileData(node.fileData as FileDataPart, apiKey);
    if (dataUrl) return dataUrl;
  }

  if ('parts' in node && Array.isArray((node as { parts?: unknown[] }).parts)) {
    const dataUrl = await extractImageDataFromNode(
      (node as { parts?: unknown[] }).parts,
      apiKey,
      visited,
    );
    if (dataUrl) return dataUrl;
  }

  if ('functionCall' in node) {
    const args = (node as { functionCall?: { args?: unknown } }).functionCall?.args;
    const dataUrl = await extractImageDataFromNode(args, apiKey, visited);
    if (dataUrl) return dataUrl;
  }

  if ('functionResponse' in node) {
    const result = (node as { functionResponse?: { result?: unknown } }).functionResponse?.result;
    const dataUrl = await extractImageDataFromNode(result, apiKey, visited);
    if (dataUrl) return dataUrl;
  }

  if ('content' in node) {
    const contentData = await extractImageDataFromNode(
      (node as { content?: unknown }).content,
      apiKey,
      visited,
    );
    if (contentData) return contentData;
  }

  for (const value of Object.values(node)) {
    if (typeof value === 'string' && value.startsWith('data:image/')) {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      const result = await extractImageDataFromNode(value, apiKey, visited);
      if (result) return result;
    }
  }

  return null;
};

const describeCollageObjects = async (apiKey: string, collageImage: string) => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'You are an interior designer. Looking at this collage of furniture and decor, invent one vivid sentence (max 25 words) describing the type of room these items belong to, including mood and one hero object.',
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: dataUrlToBase64(collageImage),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          topK: 32,
          maxOutputTokens: 128,
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error('Unable to describe collage objects');
  }
  const payload = await response.json();
  const description =
    payload?.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ??
    '';
  return description.replace(/\s+/g, ' ').trim();
};

const sanitizeInsightClause = (value?: string | null, fallback?: string) => {
  if (!value) return fallback ?? '';
  const trimmed = value.replace(/(^["'`]+|["'`]+$)/g, '').trim();
  if (!trimmed) return fallback ?? '';
  return trimmed.replace(/\s+/g, ' ');
};

const parseLayoutInsightText = (raw: string): LayoutInsight => {
  if (!raw) return {};
  const cleaned = raw.replace(/```json|```/gi, '').trim();
  const attemptParse = (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  let candidate = attemptParse(cleaned);
  if (!candidate) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      candidate = attemptParse(jsonMatch[0]);
    }
  }
  if (candidate && typeof candidate === 'object') {
    return {
      shape: typeof candidate.shape === 'string' ? candidate.shape : undefined,
      doors: typeof candidate.doors === 'string' ? candidate.doors : undefined,
      windows: typeof candidate.windows === 'string' ? candidate.windows : undefined,
    };
  }
  const shapeMatch = cleaned.match(/shape[^:]*:\s*([^\n\r]+)/i);
  const doorsMatch = cleaned.match(/door[^:]*:\s*([^\n\r]+)/i);
  const windowsMatch = cleaned.match(/window[^:]*:\s*([^\n\r]+)/i);
  return {
    shape: shapeMatch?.[1]?.trim(),
    doors: doorsMatch?.[1]?.trim(),
    windows: windowsMatch?.[1]?.trim(),
  };
};

const describeLayoutSnapshot = async (apiKey: string, layoutImage: string): Promise<LayoutInsight> => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'You are an architect describing a top-down floor plan.',
                  'Return JSON with three keys: "shape", "doors", "windows".',
                  'Each value must be a short clause (<25 words) describing:',
                  '- overall footprint shape, mentioning corners or curves;',
                  '- how doors are positioned (which wall, orientation, quantity);',
                  '- how the largest window or set of windows is positioned (assume standard full-sized windows).',
                  'Example: {"shape":"a shallow L-shape with a bay", "doors":"two entries on the south wall", "windows":"full-height glazing across the north wall"}.',
                ].join(' '),
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: dataUrlToBase64(layoutImage),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          topK: 32,
          maxOutputTokens: 256,
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error('Unable to describe layout geometry');
  }
  const payload = await response.json();
  const description =
    payload?.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ??
    '';
  const parsed = parseLayoutInsightText(description);
  return {
    shape: sanitizeInsightClause(parsed.shape),
    doors: sanitizeInsightClause(parsed.doors),
    windows: sanitizeInsightClause(parsed.windows),
  };
};

const generateLayoutNarrative = async (apiKey: string, layoutImage: string) => {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'Provide a detailed, paragraph-style description of this floor plan.',
                  'Mention every wall segment, corner, window, and door, describing how they connect or align with each other and referencing directions when possible.',
                  'Door symbols use an arc to show swing—interpret each as a standard rectangular hinged door and describe which wall the hinge sits on and which direction it swings.',
                  'Keep it under 180 words but make it precise enough for a 3D artist to imagine the space.',
                ].join(' '),
              },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: dataUrlToBase64(layoutImage),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.8,
          topK: 32,
          maxOutputTokens: 512,
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error('Unable to generate layout description');
  }
  const payload = await response.json();
  const text =
    payload?.candidates?.[0]?.content?.parts?.find((part: { text?: string }) => part.text)?.text ??
    '';
  return text.replace(/\s+/g, ' ').trim();
};

const renderPerspectiveFromDescription = async (apiKey: string, description: string) => {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  'Create a photorealistic perspective visualization of the following room description.',
                  'Show an empty architectural shell only—no furniture, decor, or loose objects—just walls, floor, ceiling, doors, and windows that appear in the text.',
                  'Use an eye-level camera, balanced natural lighting, award-winning architectural photography aesthetics, and frame it at a 16:9 aspect ratio.',
                  `Description: ${description}`,
                ].join(' '),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.6,
          topP: 0.8,
          topK: 32,
        },
      }),
    });
  } catch (error) {
    throw new Error(
      `Unable to render layout preview: ${(error as Error)?.message ?? 'network error'}`,
    );
  }
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Unable to render layout preview (${response.status}): ${message.slice(0, 400)}`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('image/')) {
    const buffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);
    const dataUrl = `data:${contentType};base64,${base64}`;
    return enforceAspectRatio(dataUrl, '16:9');
  }

  const payload = await response.json();
  const inlineImage = payload?.images?.[0]?.inlineData;
  let imageDataUrl: string | null = null;
  if (inlineImage?.data) {
    imageDataUrl = `data:${inlineImage.mimeType ?? 'image/png'};base64,${inlineImage.data}`;
  }
  if (!imageDataUrl) {
    imageDataUrl =
      (await extractImageDataFromNode(payload?.candidates ?? [], apiKey)) ??
      (await extractImageDataFromNode(payload, apiKey));
  }
  if (!imageDataUrl) {
    console.warn('Gemini layout preview payload', payload);
    throw new Error('Layout preview is missing image data');
  }
  return enforceAspectRatio(imageDataUrl, '16:9');
};

const enforceAspectRatio = async (dataUrl: string, aspectRatio: string) => {
  if (typeof document === 'undefined') return dataUrl;
  const { width, height } = aspectRatioDimensions[aspectRatio] ?? aspectRatioDimensions['16:9'];
  const image = await loadImageElement(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = (canvas.width - drawWidth) / 2;
  const offsetY = (canvas.height - drawHeight) / 2;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
  return canvas.toDataURL('image/png');
};

type NanoBananaPayload = {
  jobId: string;
  apiKey: string;
  prompt: string;
  stylePreset: string;
  aspectRatio: string;
  collageImage: string;
  layoutInsight?: LayoutInsight | null;
  layoutDescription?: string | null;
  layoutPreviewImage: string;
  lightPresetLabel?: string;
  graphicPresetLabel?: string;
};

const buildRenderSystemPrompt = (
  styleLabel: string,
  insight?: LayoutInsight | null,
  extras?: { lighting?: string; graphic?: string },
) => {
  const shapeClause =
    insight?.shape ?? 'a rectilinear outline with clearly defined right-angled corners';
  const doorsClause =
    insight?.doors ?? 'along the entry wall highlighted in the plan';
  const windowsClause =
    insight?.windows ?? 'along the facade indicated on the plan';
  const lightingClause =
    extras?.lighting && extras.lighting !== 'Not specified'
      ? `- Lighting mood: ${extras.lighting}.`
      : '';
  const graphicClause =
    extras?.graphic && extras.graphic !== 'Not specified'
      ? `- Graphical treatment: ${extras.graphic}.`
      : '';
  return `Create a NEW image of a photorealistic, eye-level 3D render of a room based on the following floor plan description. The room has ${shapeClause}. The doors are located ${doorsClause}. The large windows are located ${windowsClause}.
- Decorate the room in a ${styleLabel} style.
- Place all objects from the second image inside the room.
- Award-winning architectural photography, high level of detail.
${lightingClause}
${graphicClause}`.trim();
};

const requestNanoBananaRender = async ({
  jobId,
  apiKey,
  prompt,
  stylePreset,
  aspectRatio,
  collageImage,
  layoutInsight,
  layoutDescription,
  layoutPreviewImage,
  lightPresetLabel,
  graphicPresetLabel,
}: NanoBananaPayload) => {
  const styleLabel = styles.find((styleOption) => styleOption.id === stylePreset)?.label ?? stylePreset;
  const systemPromptText = buildRenderSystemPrompt(styleLabel, layoutInsight, {
    lighting: lightPresetLabel,
    graphic: graphicPresetLabel,
  });
  const trimmedPrompt = prompt.trim();
  const userParts: Array<
    | { text: string }
    | {
        inlineData: {
          mimeType: string;
          data: string;
        };
      }
  > = [];
  if (layoutDescription && layoutDescription.trim().length > 0) {
    userParts.push({ text: `Floor plan description: ${layoutDescription.trim()}` });
  }
  if (trimmedPrompt.length > 0) {
    userParts.push({ text: trimmedPrompt });
  }
  userParts.push({
    inlineData: { mimeType: 'image/png', data: dataUrlToBase64(layoutPreviewImage) },
  });
  userParts.push({
    inlineData: { mimeType: 'image/png', data: dataUrlToBase64(collageImage) },
  });
  const body = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemPromptText }],
    },
    contents: [
      {
        role: 'user',
        parts: userParts,
      },
    ],
    generationConfig: {
      temperature: 0.4,
      topP: 0.8,
      topK: 32,
      // Gemini 2.5 Flash Image expects aspect ratio hints in the content itself,
      // so we embed the requested ratio in the prompt and normalize client-side.
    },
  };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Nano Banana error (${response.status}): ${text}`);
  }
  type GeminiPart = {
    inlineData?: {
      mimeType?: string;
      data?: string;
    };
  };
  const payload = await response.json();
  const inlinePart =
    payload?.candidates?.[0]?.content?.parts?.find((part: GeminiPart) => part.inlineData) ?? null;
  const inlineData = inlinePart?.inlineData;
  if (!inlineData?.data) {
    throw new Error('Nano Banana did not return an image payload.');
  }
  const baseImageUrl = `data:${inlineData.mimeType ?? 'image/png'};base64,${inlineData.data}`;
  const normalizedImageUrl = await enforceAspectRatio(baseImageUrl, aspectRatio);
  return { jobId, imageUrl: normalizedImageUrl };
};

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
  { id: 'modern', label: 'Modern' },
  { id: 'contemporary', label: 'Contemporary' },
  { id: 'scandinavian', label: 'Scandinavian' },
  { id: 'minimalist', label: 'Minimalist' },
  { id: 'industrial', label: 'Industrial' },
  { id: 'mid-century', label: 'Mid-Century Modern' },
  { id: 'bohemian', label: 'Bohemian' },
  { id: 'japandi', label: 'Japandi' },
  { id: 'art-deco', label: 'Art Deco' },
  { id: 'farmhouse', label: 'Modern Farmhouse' },
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
  const [renderJobs, setRenderJobs] = useState<RenderJob[]>([]);
  const [materialEdits, setMaterialEdits] = useState<MaterialEdit[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const [wallThicknessMm, setWallThicknessMm] = useState(defaultWallThicknessMm);
  const [layoutSnapshot, setLayoutSnapshot] = useState<string | null>(null);
  const layoutSnapshotObjectUrlRef = useRef<string | null>(null);
  const layoutStageRef = useRef<KonvaStage | null>(null);
  const latestCanvasSnapshotRef = useRef<string | null>(null);

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

  const setLayoutSnapshotValue = useCallback(
    (value: string, options?: { isObjectUrl?: boolean }) => {
      if (options?.isObjectUrl) {
        if (layoutSnapshotObjectUrlRef.current) {
          URL.revokeObjectURL(layoutSnapshotObjectUrlRef.current);
        }
        layoutSnapshotObjectUrlRef.current = value;
      } else if (layoutSnapshotObjectUrlRef.current) {
        URL.revokeObjectURL(layoutSnapshotObjectUrlRef.current);
        layoutSnapshotObjectUrlRef.current = null;
      }
      setLayoutSnapshot(value);
    },
    [],
  );

  const handleLayoutSnapshotFile = useCallback(
    (file: File) => {
      const url = URL.createObjectURL(file);
      setLayoutSnapshotValue(url, { isObjectUrl: true });
    },
    [setLayoutSnapshotValue],
  );

  const handleCanvasSnapshotUpdate = useCallback(
    (dataUrl: string) => {
      latestCanvasSnapshotRef.current = dataUrl;
      if (activeStep === 1) {
        setLayoutSnapshotValue(dataUrl);
      }
    },
    [activeStep, setLayoutSnapshotValue],
  );

  const captureLayoutSnapshot = useCallback(() => {
    const stage = layoutStageRef.current;
    if (!stage) {
      if (latestCanvasSnapshotRef.current) {
        setLayoutSnapshotValue(latestCanvasSnapshotRef.current);
      } else {
        console.warn('Canvas capture unavailable. Open Step 1 to generate a snapshot.');
      }
      return;
    }
    const bounds = getLayoutContentBounds(elements);
    const stageWidth = stage.width();
    const stageHeight = stage.height();
    const padding = 80;
    const captureWidth = bounds
      ? Math.max(200, bounds.right - bounds.left + padding * 2)
      : stageWidth;
    const captureHeight = bounds
      ? Math.max(200, bounds.bottom - bounds.top + padding * 2)
      : stageHeight;
    const x = bounds ? bounds.left - padding : 0;
    const y = bounds ? bounds.top - padding : 0;
    const dataUrl = stage.toDataURL({
      x,
      y,
      width: captureWidth,
      height: captureHeight,
      pixelRatio: 2,
    });
    setLayoutSnapshotValue(dataUrl);
    latestCanvasSnapshotRef.current = dataUrl;
  }, [elements, setLayoutSnapshotValue]);

  useEffect(
    () => () => {
      if (layoutSnapshotObjectUrlRef.current) {
        URL.revokeObjectURL(layoutSnapshotObjectUrlRef.current);
      }
    },
    [],
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
            <h1 className="text-3xl font-semibold text-slate-900">Interior Design Companion</h1>
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
            stageRef={layoutStageRef}
            onCanvasSnapshot={handleCanvasSnapshotUpdate}
          />
        )}
        {activeStep === 2 && (
          <RenderStage
            furniture={furniture}
            setFurniture={setFurniture}
            prompt={prompt}
            setPrompt={setPrompt}
            renderJobs={renderJobs}
            addRenderJob={addRenderJob}
            updateRenderJob={updateRenderJob}
            layoutSnapshot={layoutSnapshot}
            onLayoutSnapshotUpload={handleLayoutSnapshotFile}
            onCaptureLayoutSnapshot={captureLayoutSnapshot}
            apiKey={apiKeys.nanoBanana}
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
  stageRef?: RefObject<KonvaStage | null>;
  onCanvasSnapshot?: (dataUrl: string) => void;
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
  stageRef,
  onCanvasSnapshot,
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
  const endpointDragSnapshotRef = useRef(false);
  const [backgroundImage] = useImage(backdropSrc ?? '');
  const thicknessPx = useMemo(() => mmToPx(wallThicknessMm), [wallThicknessMm]);
  const isDrawing = Boolean(draft);

  useEffect(() => {
    if (!stageRef?.current || !onCanvasSnapshot) return;
    const id = requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage) return;
      try {
        const dataUrl = stage.toDataURL({ pixelRatio: 2 });
        onCanvasSnapshot(dataUrl);
      } catch (error) {
        console.warn('Failed to capture layout snapshot', error);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [stageRef, onCanvasSnapshot, elements, backgroundImage, wallThicknessMm, defaultWallColor]);

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
      options?: { preserveSelectionId?: string | null; transient?: boolean },
    ): boolean => {
      const next = producer(elements);
      if (!next || next === elements) {
        return false;
      }
      if (!options?.transient) {
        historyRef.current.push(elements);
        if (historyRef.current.length > UNDO_HISTORY_LIMIT) {
          historyRef.current.shift();
        }
        setHistorySize(historyRef.current.length);
      }
      onElementsChange(next);
      if (options?.preserveSelectionId) {
        const id = options.preserveSelectionId;
        setSelectedElementId(next.some((element) => element.id === id) ? id : null);
      } else if (!options?.transient) {
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

  const captureEndpointDragSnapshot = useCallback(() => {
    if (endpointDragSnapshotRef.current) return;
    historyRef.current.push(elements);
    if (historyRef.current.length > UNDO_HISTORY_LIMIT) {
      historyRef.current.shift();
    }
    setHistorySize(historyRef.current.length);
    endpointDragSnapshotRef.current = true;
  }, [elements]);

  const releaseEndpointDragSnapshot = useCallback(() => {
    endpointDragSnapshotRef.current = false;
  }, []);

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
      const normalizedPoints = normalizePath(points);
      if (normalizedPoints.length < 2) return;
      const segments = [];
      for (let i = 0; i < normalizedPoints.length - 1; i += 1) {
        const start = normalizedPoints[i];
        const end = normalizedPoints[i + 1];
        if (distanceBetween(start, end) < 0.5) continue;
        segments.push({
          geometry: { kind: 'polyline', points: flattenPoints([start, end]) },
          rawPoints: [start, end],
        });
      }
      if (segments.length === 0) return;
      commitWallElements(segments);
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
          const originalEndpoints: [Point, Point] = [
            { ...pathPoints[0] },
            { ...pathPoints[pathPoints.length - 1] },
          ];
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
          const updatedEndpoints: [Point, Point] = [
            { ...translated[0] },
            { ...translated[translated.length - 1] },
          ];
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
          let copy = [...current];
          copy[index] = updated;
          copy = propagateWallConnections(copy, index, originalEndpoints, updatedEndpoints);
          return copy;
        },
        { preserveSelectionId: wallId },
      );
    },
    [applyElementsChange, wallSnapRefs],
  );

  const applyWallEndpointUpdate = useCallback(
    (wallId: string, endpointIndex: 0 | 1, point: Point, options?: { transient?: boolean }) => {
      return applyElementsChange(
        (current) => {
          const index = current.findIndex((element) => element.id === wallId);
          if (index === -1) return null;
          const wall = current[index];
          if (!wall.geometry || wall.geometry.kind !== 'polyline') return null;
          const pathPoints = getWallPathPoints(wall);
          if (pathPoints.length < 2) return null;
          const targetIndex = endpointIndex === 0 ? 0 : pathPoints.length - 1;
          const anchorIndex = endpointIndex === 0 ? Math.min(1, pathPoints.length - 1) : Math.max(pathPoints.length - 2, 0);
          const anchorPoint = pathPoints[anchorIndex];
          const snappedPoint = getSnappedPoint(point, anchorPoint);
          if (distanceBetween(snappedPoint, pathPoints[targetIndex]) < 0.5) {
            return null;
          }
          const originalEndpoints: [Point, Point] = [
            { ...pathPoints[0] },
            { ...pathPoints[pathPoints.length - 1] },
          ];
          pathPoints[targetIndex] = snappedPoint;
          const bounds = boundsFromPoints(pathPoints);
          const updated: LayoutElement = {
            ...wall,
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            geometry: {
              kind: 'polyline',
              points: flattenPoints(pathPoints),
            },
          };
          let next = [...current];
          next[index] = updated;
          next = propagateWallConnections(next, index, originalEndpoints, [
            pathPoints[0],
            pathPoints[pathPoints.length - 1],
          ]);
          return next;
        },
        { preserveSelectionId: wallId, transient: options?.transient },
      );
    },
    [applyElementsChange, getSnappedPoint],
  );

  const handleEndpointHandleDragStart = useCallback(() => {
    captureEndpointDragSnapshot();
  }, [captureEndpointDragSnapshot]);

  const handleEndpointHandleDragMove = useCallback(
    (wallId: string, endpointIndex: 0 | 1, event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      const pointer = getWorldPointerPosition(stage) ?? {
        x: event.target.x(),
        y: event.target.y(),
      };
      applyWallEndpointUpdate(wallId, endpointIndex, pointer, { transient: true });
    },
    [applyWallEndpointUpdate],
  );

  const handleEndpointHandleDragEnd = useCallback(
    (wallId: string, endpointIndex: 0 | 1, event: KonvaEventObject<MouseEvent>) => {
      const stage = event.target.getStage();
      const pointer = getWorldPointerPosition(stage) ?? {
        x: event.target.x(),
        y: event.target.y(),
      };
      applyWallEndpointUpdate(wallId, endpointIndex, pointer, { transient: false });
      releaseEndpointDragSnapshot();
    },
    [applyWallEndpointUpdate, releaseEndpointDragSnapshot],
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

const connectionPatchMap = new Map<string, ConnectionPatchEntry>();
const outlineEdgeMap = new Map<string, OutlineEdge>();

const addConnectionFragment = (point: Point, fragment: ConnectionPatchFragment) => {
  const key = formatConnectionKey(point);
  const existing = connectionPatchMap.get(key);
  if (existing) {
    existing.fragments.push(fragment);
  } else {
    connectionPatchMap.set(key, { point: { ...point }, fragments: [fragment] });
  }
};

const registerOutlineEdge = (pointA: Point, pointB: Point, color: string) => {
  const key = edgeKey(pointA, pointB);
  if (outlineEdgeMap.has(key)) {
    outlineEdgeMap.delete(key);
  } else {
    outlineEdgeMap.set(key, { points: [pointA, pointB], color });
  }
};

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
    return segments.flatMap((segment, idx) => {
      const baseKey = `${element.id}-${idx}`;
      const extensionAmount = strokeWidth / 2;
      const startConnected = wallSnapRefs.some(
        (ref) =>
          ref.wallId !== element.id &&
          distanceBetween(ref.point, segment[0]) <= WALL_CONNECTION_TOLERANCE / 2,
      );
      const endConnected = wallSnapRefs.some(
        (ref) =>
          ref.wallId !== element.id &&
          distanceBetween(ref.point, segment[segment.length - 1]) <=
            WALL_CONNECTION_TOLERANCE / 2,
      );
      const extendedSegment = extendOpenPath(segment, extensionAmount, {
        extendStart: startConnected,
        extendEnd: endConnected,
      });
      const commonDragProps = {
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
      };
      if (extendedSegment.length === 2) {
        const polygon = buildSegmentPolygon(extendedSegment[0], extendedSegment[1], strokeWidth);
        const polygonPoints = flattenPoints([...polygon, polygon[0]]);
        const outlineColor = isSelected ? '#4f46e5' : '#000000';
        registerOutlineEdge(polygon[0], polygon[1], outlineColor);
        registerOutlineEdge(polygon[2], polygon[3], outlineColor);
        if (!endConnected) {
          registerOutlineEdge(polygon[1], polygon[2], outlineColor);
        } else {
          addConnectionFragment(segment[segment.length - 1], {
            wallId: element.id,
            points: [polygon[1], polygon[0]],
            color: fillColor,
          });
          addConnectionFragment(segment[segment.length - 1], {
            wallId: element.id,
            points: [polygon[2], polygon[3]],
            color: fillColor,
          });
        }
        if (!startConnected) {
          registerOutlineEdge(polygon[3], polygon[0], outlineColor);
        } else {
          addConnectionFragment(segment[0], {
            wallId: element.id,
            points: [polygon[0], polygon[1]],
            color: fillColor,
          });
          addConnectionFragment(segment[0], {
            wallId: element.id,
            points: [polygon[3], polygon[2]],
            color: fillColor,
          });
        }
        return [
          <Line
            key={`${baseKey}-fill-poly`}
            {...commonDragProps}
            points={polygonPoints}
            closed
            fill={fillColor}
            strokeEnabled={false}
            shadowColor={isSelected ? '#4f46e5' : undefined}
            shadowBlur={isSelected ? 8 : 0}
            shadowOpacity={isSelected ? 0.9 : 0}
          />,
        ];
      }
      const fallbackPoints = flattenPoints(extendedSegment);
      return [
        <Line
          key={`${baseKey}-fill`}
          {...commonDragProps}
          points={fallbackPoints}
          stroke={fillColor}
          strokeWidth={strokeWidth}
          lineCap="square"
          lineJoin="miter"
        />,
      ];
    });
  });

const connectionPatches = Array.from(connectionPatchMap.entries())
  .map(([key, entry]) => {
    if (entry.fragments.length < 2) return null;
    const sorted = entry.fragments
      .map((fragment) => {
        const mid = {
          x: (fragment.points[0].x + fragment.points[1].x) / 2,
          y: (fragment.points[0].y + fragment.points[1].y) / 2,
        };
        const angle = Math.atan2(mid.y - entry.point.y, mid.x - entry.point.x);
        return { ...fragment, angle };
      })
      .sort((a, b) => a.angle - b.angle);
    const vertices: Point[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      if (current.wallId === next.wallId) continue;
      const intersection = lineIntersection(
        current.points[0],
        current.points[1],
        next.points[0],
        next.points[1],
      );
      if (intersection) {
        vertices.push(intersection);
      }
    }
    if (vertices.length < 3) return null;
    const polygonPoints = flattenPoints([...vertices, vertices[0]]);
    const color = entry.fragments[0]?.color ?? defaultColor;
    for (let i = 0; i < vertices.length; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      registerOutlineEdge(a, b, '#000000');
    }
    return (
      <Line
        key={`connection-${key}`}
        points={polygonPoints}
        closed
        fill={color}
        strokeEnabled={false}
        listening={false}
      />
    );
  })
  .filter(Boolean);

const outlineShapes = Array.from(outlineEdgeMap.values()).map((edge, idx) => (
  <Line
    key={`outline-${idx}`}
    points={flattenPoints(edge.points)}
    stroke="#000000"
    strokeWidth={2}
    lineCap="butt"
    listening={false}
  />
));

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
  const endpointHandles =
    interactionMode === 'select' &&
    selectedElement?.type === 'wall' &&
    selectedElement.geometry?.kind === 'polyline'
      ? (() => {
          const path = getWallPathPoints(selectedElement);
          if (path.length < 2) return null;
          const endpoints: { point: Point; endpointIndex: 0 | 1 }[] = [
            { point: path[0], endpointIndex: 0 },
            { point: path[path.length - 1], endpointIndex: 1 },
          ];
          return endpoints.map(({ point, endpointIndex }) => (
            <Circle
              key={`handle-${selectedElement.id}-${endpointIndex}`}
              x={point.x}
              y={point.y}
              radius={8}
              fill="#ffffff"
              stroke="#0f172a"
              strokeWidth={2}
              draggable
              onDragStart={handleEndpointHandleDragStart}
              onDragMove={(event) =>
                handleEndpointHandleDragMove(selectedElement.id, endpointIndex, event)
              }
              onDragEnd={(event) => {
                handleEndpointHandleDragEnd(selectedElement.id, endpointIndex, event);
              }}
            />
          ));
        })()
      : null;

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
              â‰ˆ {Math.round(thicknessPx)} px stroke
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
                Selecting Door/Window spawns a preview that follows your cursorâ€”click any wall
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
                    Door/window placement is activeâ€”move the cursor over a wall and click to confirm
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
            ref={stageRef ?? undefined}
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
              {connectionPatches}
              {outlineShapes}
              {openingShapes}
              {endpointHandles}
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
  furniture: FurnitureSample[];
  setFurniture: Dispatch<SetStateAction<FurnitureSample[]>>;
  prompt: string;
  setPrompt: (value: string) => void;
  renderJobs: RenderJob[];
  addRenderJob: (job: RenderJob) => void;
  updateRenderJob: (jobId: string, patch: Partial<RenderJob>) => void;
  layoutSnapshot: string | null;
  onLayoutSnapshotUpload: (file: File) => void;
  onCaptureLayoutSnapshot: () => void;
  apiKey?: string;
};

const promptStyleOptions = styles;
const lightPresetOptions = [
  { id: 'none', label: 'Not specified' },
  { id: 'north-daylight', label: 'Soft north-facing daylight' },
  { id: 'south-sun', label: 'Warm south-facing sun' },
  { id: 'evening-ambient', label: 'Evening ambient sconces' },
  { id: 'task-pendants', label: 'Task pendants over seating' },
  { id: 'floor-lamps', label: 'Cozy floor lamps' },
  { id: 'cove-led', label: 'Cove LED uplighting' },
  { id: 'museum-spot', label: 'Museum-grade spotlights' },
  { id: 'diffused-sheer', label: 'Diffused sheer-curtain light' },
  { id: 'fireplace-glow', label: 'Fireplace glow accent' },
  { id: 'neon-art', label: 'Neon wall art lighting' },
];

const graphicPresetOptions = [
  { id: 'none', label: 'Not specified' },
  { id: 'hyper-real', label: 'Hyper-real photography' },
  { id: 'cinematic', label: 'Cinematic render style' },
  { id: 'hand-drawn', label: 'Hand-drawn sketch overlay' },
  { id: 'watercolor', label: 'Watercolor illustration' },
  { id: 'linework', label: 'Crisp architectural linework' },
  { id: 'grainy-film', label: 'Grainy film still' },
  { id: '3d-studio', label: '3D studio visualization' },
  { id: 'bold-graphic', label: 'Bold graphic poster' },
  { id: 'soft-pastel', label: 'Soft pastel rendering' },
  { id: 'tech-visual', label: 'Tech visualization' },
];

function RenderStage({
  furniture,
  setFurniture,
  prompt,
  setPrompt,
  renderJobs,
  addRenderJob,
  updateRenderJob,
  layoutSnapshot,
  onLayoutSnapshotUpload,
  onCaptureLayoutSnapshot,
  apiKey,
}: RenderStageProps) {
  const [uploading, setUploading] = useState(false);
  const [aspectRatio, setAspectRatioState] = useState('16:9');
  const [collageDataUrl, setCollageDataUrl] = useState<string | null>(null);
  const [renderHelperMessage, setRenderHelperMessage] = useState<string | null>(null);
  const [promptStyleId, setPromptStyleId] = useState(promptStyleOptions[0]?.id ?? 'modern');
  const [lightPresetId, setLightPresetId] = useState(lightPresetOptions[0]?.id ?? 'none');
  const [graphicPresetId, setGraphicPresetId] = useState(
    graphicPresetOptions[0]?.id ?? 'none',
  );
  const [collageDescription, setCollageDescription] = useState<string | null>(null);
  const [collageDescriptionStatus, setCollageDescriptionStatus] =
    useState<CollageDescriptionStatus>('idle');
  const [layoutInsight, setLayoutInsight] = useState<LayoutInsight | null>(null);
  const [layoutInsightStatus, setLayoutInsightStatus] =
    useState<LayoutInsightStatus>('idle');
  const [layoutNarrative, setLayoutNarrative] = useState<string | null>(null);
  const [layoutNarrativeStatus, setLayoutNarrativeStatus] =
    useState<LayoutNarrativeStatus>('idle');
  const [layoutNarrativeError, setLayoutNarrativeError] = useState<string | null>(null);
  const [layoutPreviewImage, setLayoutPreviewImage] = useState<string | null>(null);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const styleLookup = useMemo(() => {
    const map: Record<string, string> = {};
    styles.forEach((styleOption) => {
      map[styleOption.id] = styleOption.label;
    });
    return map;
  }, []);
  const collageImages = useMemo(() => furniture.slice(0, 6), [furniture]);
  const heroRender = useMemo(
    () => renderJobs.find((job) => job.status === 'complete') ?? renderJobs[0],
    [renderJobs],
  );
  const promptStyleLabel =
    promptStyleOptions.find((styleOption) => styleOption.id === promptStyleId)?.label ??
    promptStyleOptions[0]?.label ??
    'Modern';
  const lightPresetLabel =
    lightPresetOptions.find((option) => option.id === lightPresetId)?.label ??
    lightPresetOptions[0]?.label ??
    '';
  const graphicPresetLabel =
    graphicPresetOptions.find((option) => option.id === graphicPresetId)?.label ??
    graphicPresetOptions[0]?.label ??
    '';
  const renderFormValues = useMemo(
    () => ({
      prompt: prompt ?? '',
      aspectRatio,
    }),
    [prompt, aspectRatio],
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RenderForm>({
    resolver: zodResolver(renderSchema),
    values: renderFormValues,
  });

  const renderMutation = useMutation<
    { jobId: string; imageUrl: string },
    Error,
    NanoBananaPayload
  >({
    mutationFn: requestNanoBananaRender,
    onSuccess: ({ jobId, imageUrl }) => {
      setRenderHelperMessage(null);
      updateRenderJob(jobId, { status: 'complete', imageUrl });
    },
    onError: (error, variables) => {
      const message = error instanceof Error ? error.message : 'Render failed.';
      setRenderHelperMessage(message);
      if (variables?.jobId) {
        updateRenderJob(variables.jobId, { status: 'idle' });
      }
    },
  });

  useEffect(() => {
    let cancelled = false;
    if (collageImages.length === 0) {
      requestAnimationFrame(() => {
        if (!cancelled) {
          setCollageDataUrl(null);
        }
      });
      return;
    }
    (async () => {
      try {
        const dataUrl = await composeCollageDataUrl(collageImages);
        if (!cancelled) {
          setCollageDataUrl(dataUrl);
        }
      } catch (error) {
        console.warn('Failed to compose collage data', error);
        if (!cancelled) {
          setCollageDataUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [collageImages]);

  useEffect(() => {
    let cancelled = false;
    const schedule = (fn: () => void) => {
      setTimeout(() => {
        if (!cancelled) {
          fn();
        }
      }, 0);
    };
    if (!collageDataUrl) {
      schedule(() => {
        setCollageDescription(null);
        setCollageDescriptionStatus('idle');
      });
      return () => {
        cancelled = true;
      };
    }
    if (!apiKey) {
      schedule(() => {
        setCollageDescription(null);
        setCollageDescriptionStatus('needs-key');
      });
      return () => {
        cancelled = true;
      };
    }
    schedule(() => {
      setCollageDescriptionStatus('loading');
    });
    describeCollageObjects(apiKey, collageDataUrl)
      .then((summary) => {
        if (cancelled) return;
        setCollageDescription(summary || null);
        setCollageDescriptionStatus('idle');
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Failed to describe collage for prompt template', error);
        setCollageDescription(null);
        setCollageDescriptionStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, collageDataUrl]);

  useEffect(() => {
    let cancelled = false;
    const schedule = (fn: () => void) => {
      setTimeout(() => {
        if (!cancelled) {
          fn();
        }
      }, 0);
    };
    if (!layoutSnapshot) {
      schedule(() => {
        setLayoutInsight(null);
        setLayoutInsightStatus('idle');
      });
      return () => {
        cancelled = true;
      };
    }
    if (!apiKey) {
      schedule(() => {
        setLayoutInsight(null);
        setLayoutInsightStatus('needs-key');
      });
      return () => {
        cancelled = true;
      };
    }
    schedule(() => {
      setLayoutInsightStatus('loading');
    });
    describeLayoutSnapshot(apiKey, layoutSnapshot)
      .then((insight) => {
        if (cancelled) return;
        setLayoutInsight(insight);
        setLayoutInsightStatus('idle');
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Failed to analyze layout snapshot', error);
        setLayoutInsight(null);
        setLayoutInsightStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiKey, layoutSnapshot]);

  useEffect(() => {
    let cancelled = false;
    setTimeout(() => {
      if (cancelled) return;
      setLayoutNarrative(null);
      setLayoutPreviewImage(null);
      setLayoutNarrativeStatus('idle');
      setLayoutNarrativeError(null);
    }, 0);
    return () => {
      cancelled = true;
    };
  }, [layoutSnapshot]);

  const onSubmit = (values: RenderForm) => {
    if (!apiKey) {
      setRenderHelperMessage('Add your Nano Banana API key in API settings to request renders.');
      return;
    }
    if (!collageDataUrl) {
      setRenderHelperMessage('Upload at least one object image to build a collage.');
      return;
    }
    if (!layoutPreviewImage) {
      setRenderHelperMessage('Generate the layout description and preview before requesting a render.');
      return;
    }
    setRenderHelperMessage(null);
    const trimmedPrompt = (values.prompt ?? '').trim();
    setPrompt(trimmedPrompt);
    setAspectRatioState(values.aspectRatio);
    const jobId = generateId();
    addRenderJob({
      id: jobId,
      prompt: trimmedPrompt,
      stylePreset: promptStyleId,
      aspectRatio: values.aspectRatio,
      status: 'processing',
      createdAt: timestamp(),
    });
    renderMutation.mutate({
      jobId,
      apiKey,
      prompt: trimmedPrompt,
      stylePreset: promptStyleId,
      aspectRatio: values.aspectRatio,
      collageImage: collageDataUrl,
      layoutInsight,
      layoutDescription: layoutNarrative,
      layoutPreviewImage,
      lightPresetLabel: lightPresetId !== 'none' ? lightPresetLabel : undefined,
      graphicPresetLabel: graphicPresetId !== 'none' ? graphicPresetLabel : undefined,
    });
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

  const handleGenerateLayoutNarrative = useCallback(async () => {
    if (!apiKey) {
      setLayoutNarrativeStatus('needs-key');
      setLayoutNarrativeError('Add your Nano Banana API key to describe the layout.');
      return;
    }
    if (!layoutSnapshot) {
      setLayoutNarrativeStatus('error');
      setLayoutNarrativeError('Capture the layout canvas before generating a description.');
      return;
    }
    try {
      setLayoutNarrativeStatus('loading');
      setLayoutNarrativeError(null);
      setLayoutNarrative(null);
      setLayoutPreviewImage(null);
      const description = await generateLayoutNarrative(apiKey, layoutSnapshot);
      setLayoutNarrative(description);
      const preview = await renderPerspectiveFromDescription(apiKey, description);
      setLayoutPreviewImage(preview);
      setLayoutNarrativeStatus('idle');
    } catch (error) {
      console.error(error);
      setLayoutNarrativeStatus('error');
      setLayoutNarrativeError(
        error instanceof Error ? error.message : 'Failed to describe the layout.',
      );
    }
  }, [apiKey, layoutSnapshot]);

  const handleLayoutSnapshotInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    onLayoutSnapshotUpload(file);
    event.target.value = '';
  };

  const handleShowImage = useCallback((src?: string) => {
    if (!src || typeof window === 'undefined') return;
    window.open(src, '_blank', 'noopener,noreferrer');
  }, []);

  const handleSaveImage = useCallback((src?: string, filename = 'render.png') => {
    if (!src || typeof document === 'undefined') return;
    const link = document.createElement('a');
    link.href = src;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  return (
    <section className="space-y-6 rounded-3xl bg-transparent">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Layout</h3>
            <div className="flex gap-2">
              <input
                id="layout-snapshot-upload"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLayoutSnapshotInput}
              />
              <label
                htmlFor="layout-snapshot-upload"
                className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-300"
              >
                Upload
              </label>
              <button
                type="button"
                onClick={onCaptureLayoutSnapshot}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-300"
              >
                Canvas
              </button>
              <button
                type="button"
                onClick={handleGenerateLayoutNarrative}
                className="rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:border-slate-300 disabled:opacity-60"
                disabled={layoutNarrativeStatus === 'loading'}
              >
                {layoutNarrativeStatus === 'loading' ? 'Generating...' : 'Generate description'}
              </button>
            </div>
          </div>
          <div className="mt-4 h-[360px] w-full overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
            {layoutSnapshot ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={layoutSnapshot}
                alt="Layout screenshot"
                className="h-full w-full object-contain bg-white"
              />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-slate-400">
                No screenshot yet. Export from Step 1 and drop it here.
              </p>
            )}
          </div>
          {layoutInsightStatus === 'loading' && (
            <p className="mt-2 text-xs text-slate-500">Analyzing layout geometry...</p>
          )}
          {layoutInsightStatus === 'needs-key' && (
            <p className="mt-2 text-xs text-amber-600">
              Add your Nano Banana API key to capture room shape, door, and window details automatically.
            </p>
          )}
          {layoutInsightStatus === 'error' && (
            <p className="mt-2 text-xs text-rose-500">
              Unable to analyze this snapshot. Re-capture the canvas or try again later.
            </p>
          )}
          {layoutInsightStatus === 'idle' && layoutInsight && (
            <p className="mt-2 text-xs text-slate-500">
              Shape: {layoutInsight.shape ?? '-'} · Doors: {layoutInsight.doors ?? '-'} · Windows{' '}
              {layoutInsight.windows ?? '-'}
            </p>
          )}

          {layoutNarrativeError && (

            <p className="mt-2 text-xs text-rose-500">{layoutNarrativeError}</p>

          )}

          {layoutNarrativeStatus === 'needs-key' && (

            <p className="mt-2 text-xs text-amber-600">

              Add your Nano Banana API key to generate a description and preview image.

            </p>

          )}

          {layoutNarrative && (

            <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/60 p-4">

              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">

                Generated layout description

              </p>

              <p className="mt-2 text-sm leading-relaxed text-slate-700">{layoutNarrative}</p>

            </div>

          )}

          {layoutPreviewImage && (
            <div className="group relative mt-4 flex min-h-[12rem] items-center justify-center overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={layoutPreviewImage}
                alt="Layout preview render"
                className="max-h-[16rem] w-full object-contain"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-slate-900/0 opacity-0 transition group-hover:bg-slate-900/30 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => handleShowImage(layoutPreviewImage)}
                  className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                >
                  Show
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleSaveImage(layoutPreviewImage, 'layout-perspective-preview.png')
                  }
                  className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                >
                  Save
                </button>
              </div>
            </div>
          )}


        </div>
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">Objects</h3>
            <div>
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
                Add images
              </label>
            </div>
          </div>
          {uploading && (
            <p className="mt-2 text-xs text-[var(--accent)]">Importing samples...</p>
          )}
          <div className="mt-4 h-48 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-2">
            {collageImages.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-slate-400">
                Drop at least one reference to generate a collage.
              </p>
            ) : (
              <div className="grid h-full grid-cols-3 grid-rows-2 gap-2">
                {collageImages.map((item) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={item.id}
                    src={item.previewUrl}
                    alt={item.name}
                    className="h-full w-full rounded-xl object-cover"
                  />
                ))}
              </div>
            )}
          </div>
          {furniture.length > 0 && (
            <p className="mt-3 text-xs text-slate-500">
              {furniture.length} asset{furniture.length === 1 ? '' : 's'} ready for the collage.
            </p>
          )}
          {collageDescriptionStatus === 'idle' && collageDescription && (
            <p className="mt-2 text-xs italic text-slate-500">Collage summary: {collageDescription}</p>
          )}
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Text prompt (optional)</h3>
          <textarea
            {...register('prompt')}
            rows={8}
            className="mt-4 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm focus:border-[var(--accent)] focus:outline-none"
            placeholder="Describe mood, materials, lighting, hero pieces..."
          />
          {errors.prompt && (
            <p className="mt-1 text-xs text-rose-500">{errors.prompt.message}</p>
          )}
          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/50 p-4 text-sm text-slate-600">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Prompt template
            </p>
            <p className="mt-2 leading-relaxed">
              Create a photorealistic perspective rendering in a{' '}
              <select
                value={promptStyleId}
                onChange={(event) => setPromptStyleId(event.target.value)}
                className="inline-flex rounded-full border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 focus:border-[var(--accent)] focus:outline-none"
              >
                {promptStyleOptions.map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.label}
                  </option>
                ))}
              </select>{' '}
              style.
            </p>
            {collageDescriptionStatus === 'loading' && (
              <p className="mt-2 text-xs text-slate-500">Analyzing collage for furniture context...</p>
            )}
            {collageDescriptionStatus === 'needs-key' && (
              <p className="mt-2 text-xs text-amber-600">
                Add your Nano Banana API key in API settings to summarize the collage automatically.
              </p>
            )}
            {collageDescriptionStatus === 'error' && (
              <p className="mt-2 text-xs text-rose-500">
                Couldn&apos;t understand the collage. Re-upload objects or try again.
              </p>
            )}
            <button
              type="button"
              onClick={() => setShowSystemPrompt((prev) => !prev)}
              className="mt-3 rounded-full border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600 hover:border-slate-300"
            >
              {showSystemPrompt ? 'Hide system prompt' : 'Show system prompt'}
            </button>
            {showSystemPrompt && (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 p-3 text-[11px] leading-relaxed text-slate-600">
                <p className="whitespace-pre-wrap">
                  {buildRenderSystemPrompt(promptStyleLabel, layoutInsight, {
                    lighting: lightPresetId !== 'none' ? lightPresetLabel : undefined,
                    graphic: graphicPresetId !== 'none' ? graphicPresetLabel : undefined,
                  })}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Settings</h3>
          <div className="mt-4 space-y-4">
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Light preset
              <select
                value={lightPresetId}
                onChange={(event) => setLightPresetId(event.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              >
                {lightPresetOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Graphical style preset
              <select
                value={graphicPresetId}
                onChange={(event) => setGraphicPresetId(event.target.value)}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              >
                {graphicPresetOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold uppercase text-slate-500">
              Aspect ratio
              <select
                {...register('aspectRatio')}
                className="mt-1 w-full rounded-2xl border border-slate-200 px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
              >
                {aspectRatioOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="submit"
            className="mt-6 w-full rounded-2xl bg-[var(--accent)] py-3 text-sm font-semibold text-white hover:bg-indigo-600 disabled:opacity-60"
            disabled={renderMutation.isPending}
          >
            {renderMutation.isPending ? 'Requesting Nano Banana render...' : 'Request render'}
          </button>
          {renderHelperMessage && (
            <p className="mt-3 text-xs text-rose-500">{renderHelperMessage}</p>
          )}
        </div>
      </form>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Final render</h3>
              <p className="text-xs text-slate-500">We surface the most recent request here.</p>
            </div>
            {heroRender && (
              <span
                className={clsx(
                  'rounded-full px-3 py-1 text-xs font-semibold',
                  heroRender.status === 'complete'
                    ? 'bg-emerald-50 text-emerald-600'
                    : 'bg-amber-50 text-amber-600',
                )}
              >
                {heroRender.status === 'complete' ? 'Ready' : 'Processing'}
              </span>
            )}
          </div>
          <div className="mt-4">
            {heroRender?.imageUrl ? (
              <div className="group relative flex min-h-[18rem] items-center justify-center overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={heroRender.imageUrl}
                  alt="Latest render"
                  className="max-h-[28rem] w-full object-contain"
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-slate-900/0 opacity-0 transition group-hover:bg-slate-900/30 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => handleShowImage(heroRender.imageUrl)}
                    className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSaveImage(heroRender.imageUrl, 'hero-render.png')}
                    className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[18rem] items-center justify-center overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
                <p className="flex h-72 items-center justify-center text-sm text-slate-400">
                  No render yet. Configure settings and request one.
                </p>
              </div>
            )}
          </div>
          {heroRender && (
            <p className="mt-3 text-xs text-slate-500">
              {styleLookup[heroRender.stylePreset] ?? 'Custom preset'} Â·{' '}
              {heroRender.aspectRatio ?? aspectRatio}
            </p>
          )}
        </div>
        <div className="rounded-3xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900">History</h3>
            <span className="text-xs text-slate-400">{renderJobs.length} requests</span>
          </div>
          <div className="mt-4 space-y-3">
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
                      {styleLookup[job.stylePreset] ?? 'Custom preset'} Â· {job.aspectRatio ?? '16:9'}
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
                  <div className="group relative mt-3 flex min-h-[10rem] items-center justify-center overflow-hidden rounded-2xl border border-slate-100 bg-slate-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={job.imageUrl}
                      alt="Render preview"
                      className="max-h-[18rem] w-full object-contain"
                    />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 bg-slate-900/0 opacity-0 transition group-hover:bg-slate-900/30 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => handleShowImage(job.imageUrl)}
                        className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                      >
                        Show
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveImage(job.imageUrl, `render-${job.id}.png`)}
                        className="pointer-events-auto rounded-full bg-white/90 px-4 py-2 text-xs font-semibold text-slate-900 shadow"
                      >
                        Save
                      </button>
                    </div>
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

const lineIntersection = (a1: Point, a2: Point, b1: Point, b2: Point): Point | null => {
  const r = { x: a2.x - a1.x, y: a2.y - a1.y };
  const s = { x: b2.x - b1.x, y: b2.y - b1.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b1.x - a1.x) * s.y - (b1.y - a1.y) * s.x) / denom;
  return { x: a1.x + t * r.x, y: a1.y + t * r.y };
};

