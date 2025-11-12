'use client';

type RenderPayload = {
  jobId: string;
  prompt: string;
  layoutName: string;
  stylePreset: string;
};

type MaterialPayload = {
  editId: string;
  elementLabel: string;
  material: string;
  color: string;
};

const placeholderRenders = [
  'https://images.unsplash.com/photo-1488462237308-ecaa28b729d9?auto=format&fit=crop&w=1400&q=80',
  'https://images.unsplash.com/photo-1505691938895-1758d7feb511?auto=format&fit=crop&w=1400&q=80',
  'https://images.unsplash.com/photo-1449247709967-d4461a6a6103?auto=format&fit=crop&w=1400&q=80',
];

export function simulateRenderRequest(payload: RenderPayload) {
  return new Promise<{ jobId: string; imageUrl: string }>((resolve) => {
    const imageUrl =
      placeholderRenders[Math.floor(Math.random() * placeholderRenders.length)];
    window.setTimeout(() => {
      resolve({
        jobId: payload.jobId,
        imageUrl,
      });
    }, 1800);
  });
}

export function simulateMaterialEdit(payload: MaterialPayload) {
  return new Promise<{ editId: string; previewUrl: string }>((resolve) => {
    const previewUrl =
      placeholderRenders[Math.floor(Math.random() * placeholderRenders.length)];
    window.setTimeout(() => {
      resolve({
        editId: payload.editId,
        previewUrl,
      });
    }, 1400);
  });
}
