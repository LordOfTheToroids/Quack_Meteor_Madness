import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

export interface AsteroidModelOptions {
  scale?: number;          // uniform scale applied after load
  fallbackSphere?: boolean; // create a procedural sphere if model missing
}

export async function loadAsteroidModel(_ignoredId: string, opts: AsteroidModelOptions = {}): Promise<THREE.Object3D> {
  const { scale = 1, fallbackSphere = true } = opts;
  // Updated: single generic model expected at public/models/generic_asteroid.glb
  const path = `/models/generic_asteroid.glb`;
  try {
    const gltf = await loader.loadAsync(path);
    const root = gltf.scene || gltf.scenes[0];
    if (scale !== 1) root.scale.setScalar(scale);
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (mesh.material) {
          const mtl = mesh.material as THREE.MeshStandardMaterial;
          if (mtl.map) mtl.map.anisotropy = 8;
        }
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      }
    });
    return root;
  } catch {
    // fall through to fallback
  }
  if (!fallbackSphere) throw new Error('Generic asteroid model not found at ' + path);
  const geom = new THREE.IcosahedronGeometry(0.5, 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, flatShading: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.scale.setScalar(scale);
  return mesh;
}
