export type LayoutElementType = 'wall' | 'door' | 'window';

export type WallGeometry =
  | { kind: 'polyline'; points: number[] }
  | { kind: 'rectangle'; points: number[] }
  | { kind: 'arc'; points: number[] };

export type OpeningGeometry = {
  kind: 'opening';
  width: number;
  height: number;
  x: number;
  y: number;
  angle?: number;
  wallId?: string;
  distanceAlongPath?: number;
  wallPathLength?: number;
};

export type LayoutGeometry = WallGeometry | OpeningGeometry;

export type LayoutElement = {
  id: string;
  type: LayoutElementType;
  label: string;
  width: number;
  height: number;
  left: number;
  top: number;
  angle: number;
  fill: string;
  geometry?: LayoutGeometry;
  thicknessMm?: number;
  materialName?: string;
};
