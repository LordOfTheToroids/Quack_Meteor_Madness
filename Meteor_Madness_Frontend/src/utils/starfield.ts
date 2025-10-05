import * as THREE from 'three';
import { AU } from './orbitalMechanics';

interface StarfieldOptions {
  count?: number;
  radius?: number;
  size?: number;
}

function createStarTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Unable to create starfield texture');
  }

  const gradient = context.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );

  gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gradient.addColorStop(0.2, 'rgba(230, 242, 255, 0.85)');
  gradient.addColorStop(0.55, 'rgba(150, 188, 255, 0.5)');
  gradient.addColorStop(1, 'rgba(10, 16, 30, 0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function createStarfield({
  count = 3600,
  radius = AU * 10,
  size = 1.4,
}: StarfieldOptions = {}): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const index = i * 3;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    const sinPhi = Math.sin(phi);

    positions[index] = r * sinPhi * Math.cos(theta);
    positions[index + 1] = r * Math.cos(phi);
    positions[index + 2] = r * sinPhi * Math.sin(theta);

  const intensity = 0.55 + Math.random() * 0.4;
  const blueTint = 0.82 + Math.random() * 0.18;
  colors[index] = intensity;
  colors[index + 1] = intensity * blueTint;
  colors[index + 2] = intensity * (0.95 + Math.random() * 0.05);
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    map: createStarTexture(),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  sizeAttenuation: false,
  size,
    opacity: 1,
    vertexColors: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.name = 'Starfield';
  return points;
}
